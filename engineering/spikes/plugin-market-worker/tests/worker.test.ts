import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL } from 'node:url'
import { newHttpBatchRpcSession } from 'capnweb'
import { eq } from 'drizzle-orm'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { edits, notifications, registrations } from '../src/schema'
import { claim, connect, enqueue, failAttempt } from '../src/store'
import type { MarketAdmin } from '../src/worker'

describe('market primitives on local workerd and D1', () => {
	let runtime: Miniflare
	let db: ReturnType<typeof connect>
	let origin: URL
	let directory: string
	let script: string
	const token = crypto.randomUUID()
	const coordinate = {
		registry: 'https://registry.npmjs.org',
		packageName: '@example/plugin',
		version: '1.0.0',
	}

	async function start() {
		runtime = new Miniflare({
			host: '127.0.0.1',
			port: 0,
			resourcePersistencePath: directory,
			workers: [
				{
					config: {
						name: 'market-spike',
						compatibilityDate: '2026-11-03',
						manifest: {
							mainModule: 'worker.mjs',
							modules: { 'worker.mjs': { type: 'esm', contents: script } },
						},
						env: {
							DB: { type: 'd1', id: 'market-spike' },
							ADMIN_TOKEN: { type: 'text', value: token },
						},
					},
				},
			],
		})
		origin = new URL((await runtime.ready).href)
		db = connect(await runtime.getD1Database('DB'))
	}

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'pluxel-market-d1-'))
		const output = await build({
			entryPoints: ['src/worker.ts'],
			bundle: true,
			write: false,
			format: 'esm',
			platform: 'browser',
		})
		script = output.outputFiles[0].text
		await start()
		const binding = await runtime.getD1Database('DB')
		const migration = await readFile(
			new URL('../migrations/0000_thankful_frank_castle.sql', import.meta.url),
			'utf8',
		)
		await binding.batch(
			migration.split('--> statement-breakpoint').map((statement) => binding.prepare(statement)),
		)
	})

	afterAll(async () => {
		try {
			await runtime?.dispose()
		} finally {
			if (directory) await rm(directory, { recursive: true, force: true })
		}
	})

	beforeEach(async () => {
		await db.batch([
			db.delete(edits),
			db.delete(notifications),
			db.delete(registrations),
			db.insert(registrations).values({ id: 'example', label: 'Original' }),
		])
	})

	function admin(auth = token) {
		return newHttpBatchRpcSession<MarketAdmin>(
			new Request(new URL('/admin', origin).href, {
				headers: { Authorization: `Bearer ${auth}` },
			}),
		)
	}

	function notify(value: unknown = coordinate) {
		return fetch(new URL('/notifications', origin).href, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(value),
		})
	}

	it('accepts duplicate HTTP notifications once and exposes a pending receipt', async () => {
		const responses = await Promise.all([notify(), notify()])
		expect(responses.map((response) => response.status)).toEqual([202, 202])
		const [first, second] = await Promise.all(responses.map((response) => response.json()))
		expect(first).toEqual(second)
		expect(first).toMatchObject({ ...coordinate, status: 'pending' })
		expect(await db.select().from(notifications)).toHaveLength(1)
		const location = responses[0].headers.get('Location')!
		const stored = await fetch(new URL(location, origin).href)
		expect(await stored.json()).toEqual(first)
	})

	it('rejects unsupported sources, non-exact versions, malformed names and extra inputs', async () => {
		for (const invalid of [
			{ ...coordinate, registry: 'https://unconfigured.example' },
			{ ...coordinate, version: 'latest' },
			{ ...coordinate, version: '^1.0.0' },
			{ ...coordinate, packageName: '../plugin' },
			{ ...coordinate, tarball: 'https://unconfigured.example/file.tgz' },
		]) {
			const response = await notify(invalid)
			expect(response.status).toBe(400)
			expect(response.headers.get('Content-Type')).toContain('application/problem+json')
			await response.arrayBuffer()
		}
		expect(await db.select().from(notifications)).toHaveLength(0)
	})

	it('authenticates HTTP batch before exposing the management target', async () => {
		using denied = admin('wrong-token')
		await expect(
			denied.editRecord({ id: 'example', expectedRevision: 1, label: 'Unauthorized' }),
		).rejects.toThrow()
		using allowed = admin()
		expect(await allowed.getRecord('example')).toEqual({
			id: 'example',
			label: 'Original',
			revision: 1,
		})
		expect(await db.select().from(edits)).toHaveLength(0)
	})

	it('allows one concurrent edit and commits only its audit record', async () => {
		using first = admin()
		using second = admin()
		const results = await Promise.all([
			first.editRecord({ id: 'example', expectedRevision: 1, label: 'First' }),
			second.editRecord({ id: 'example', expectedRevision: 1, label: 'Second' }),
		])
		expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'updated'])
		expect(await db.select().from(edits)).toMatchObject([
			{ recordId: 'example', revision: 2, actor: 'spike-admin' },
		])
		using fresh = admin()
		const current = await fresh.getRecord('example')
		const winner = results.find((result) => result.status === 'updated')!
		expect(current).toEqual(winner.record)
	})

	it('rejects invalid edits and does not reuse a completed batch stub', async () => {
		using invalid = admin()
		expect(await invalid.editRecord({ id: 'example', expectedRevision: 0, label: '' })).toEqual({
			status: 'invalid',
		})
		using batch = admin()
		expect(await batch.getRecord('example')).toMatchObject({ revision: 1 })
		await expect(batch.getRecord('example')).rejects.toThrow()
		expect(await db.select().from(edits)).toHaveLength(0)
	})

	it('rolls back earlier writes when a later SQL statement fails', async () => {
		await expect(
			db.batch([
				db
					.update(registrations)
					.set({ label: 'Must roll back' })
					.where(eq(registrations.id, 'example')),
				db.insert(registrations).values({ id: 'example', label: 'Duplicate primary key' }),
			]),
		).rejects.toThrow()
		expect(await db.select().from(registrations)).toEqual([
			{ id: 'example', label: 'Original', revision: 1 },
		])
	})

	it('claims once, recovers an expired lease and rejects the old worker result', async () => {
		const task = await enqueue(db, coordinate)
		const claims = await Promise.all([claim(db, task.id, 100, 10), claim(db, task.id, 100, 10)])
		expect(claims.filter(Boolean)).toHaveLength(1)
		const original = claims.find((value) => value !== null)!
		expect(
			await failAttempt(db, {
				id: task.id,
				leaseToken: original.leaseToken!,
				now: 110,
				diagnostic: 'expired',
			}),
		).toBe(false)
		const recovered = await claim(db, task.id, 110, 10)
		expect(recovered).toMatchObject({ attempt: 2, status: 'processing' })
		expect(recovered!.leaseToken).not.toBe(original.leaseToken)
		expect(
			await failAttempt(db, {
				id: task.id,
				leaseToken: original.leaseToken!,
				now: 111,
				diagnostic: 'stale',
			}),
		).toBe(false)
		expect(
			await failAttempt(db, {
				id: task.id,
				leaseToken: recovered!.leaseToken!,
				now: 111,
				diagnostic: 'proof unavailable',
			}),
		).toBe(true)
		expect(await db.select().from(notifications)).toMatchObject([
			{ status: 'failed', diagnostic: 'proof unavailable', attempt: 2 },
		])
		const replay = await notify()
		expect(replay.status).toBe(200)
		expect(await replay.json()).toMatchObject({ id: task.id, status: 'failed' })
		expect(await db.select().from(notifications)).toHaveLength(1)
	})

	it('keeps accepted receipts after the Worker process is recreated', async () => {
		const accepted = await notify()
		const original = await accepted.json()
		const location = accepted.headers.get('Location')!
		await runtime.dispose()
		await start()
		const restored = await fetch(new URL(location, origin).href)
		expect(restored.status).toBe(200)
		expect(await restored.json()).toEqual(original)
		const duplicate = await notify()
		expect(await duplicate.json()).toEqual(original)
	})
})

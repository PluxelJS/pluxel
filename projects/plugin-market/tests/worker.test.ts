import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { newHttpBatchRpcSession } from 'capnweb'
import { eq } from 'drizzle-orm'
import { build } from 'esbuild'
import { Miniflare, Response as MiniflareResponse } from 'miniflare'
import { packTar, type TarEntry } from 'modern-tar'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { MarketAdmin } from '../src/admin'
import { MarketError, registry, type PackagePage, type Receipt } from '../src/protocol'
import { audits, notifications, packages, releases } from '../src/schema'
import {
	claim,
	commitRelease,
	connect,
	enqueue,
	failAttempt,
	maxAttempts,
	pendingNotifications,
} from '../src/store'

type Fixture = {
	registry: string
	name: string
	version: string
	bytes: Uint8Array
	integrity: string
	metadata: Record<string, unknown>
	tags: Record<string, string>
}

describe('plugin market on workerd and D1', () => {
	let runtime: Miniflare
	let db: ReturnType<typeof connect>
	let origin: URL
	let directory: string
	let script: string
	const token = crypto.randomUUID()
	const privateRegistry = 'https://private.example/npm'
	const sources = [
		{ registry, access: 'public' },
		{
			registry: privateRegistry,
			access: 'admin',
			token: 'read-private',
			notificationToken: 'notify-private',
		},
	]
	const fixtures = new Map<string, Fixture>()
	const requests: string[] = []
	let github = { status: 200, body: { full_name: 'unverified/claim', stargazers_count: 42 } }
	const selected = { registry, name: '@example/plugin', version: '1.0.0' }

	async function fixture(
		name = selected.name,
		options: {
			registry?: string
			version?: string
			manifest?: Record<string, unknown>
			extra?: TarEntry[]
		} = {},
	) {
		const source = options.registry ?? registry
		const version = options.version ?? selected.version
		const body = JSON.stringify({
			name,
			version,
			description: `Package ${name}`,
			exports: { '.': './dist/index.mjs' },
			peerDependencies: { '@pluxel/core': '^1.0.0' },
			repository: 'https://github.com/unverified/claim',
			...options.manifest,
		})
		const bytes = gzipSync(
			await packTar([
				{
					header: {
						name: 'package/package.json',
						size: new TextEncoder().encode(body).byteLength,
						type: 'file',
					},
					body,
				},
				{
					header: { name: 'package/dist/index.mjs', size: 25, type: 'file' },
					body: 'throw new Error("run!");\n',
				},
				...(options.extra ?? []),
			]),
		)
		const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
		const result: Fixture = {
			registry: source,
			name,
			version,
			bytes,
			integrity,
			tags: { latest: version },
			metadata: {
				name,
				version,
				description: 'Untrusted metadata description',
				dist: {
					tarball: `${source}/${encodeURIComponent(name)}/-/${version}.tgz`,
					integrity,
				},
			},
		}
		fixtures.set(`${source}:${name}@${version}`, result)
		return result
	}

	async function start() {
		runtime = new Miniflare({
			host: '127.0.0.1',
			port: 0,
			resourcePersistencePath: directory,
			workers: [
				{
					config: {
						name: 'plugin-market-test',
						compatibilityDate: '2026-11-03',
						manifest: {
							mainModule: 'worker.mjs',
							modules: { 'worker.mjs': { type: 'esm', contents: script } },
						},
						env: {
							DB: { type: 'd1', id: 'plugin-market-test' },
							ADMIN_TOKEN: { type: 'text', value: token },
							REGISTRIES: { type: 'text', value: JSON.stringify(sources) },
						},
					},
					dev: {
						outboundService: {
							type: 'fetcher',
							handler(request) {
								requests.push(request.url)
								const url = new URL(request.url)
								if (url.origin === 'https://api.github.com')
									return MiniflareResponse.json(github.body, { status: github.status })
								if (!sources.some((source) => request.url.startsWith(`${source.registry}/`)))
									throw new Error(`Unexpected source ${url.origin}`)
								if (request.url.startsWith(`${privateRegistry}/`))
									expect(request.headers.get('Authorization')).toBe('Bearer read-private')
								for (const item of fixtures.values()) {
									if (request.url === `${item.registry}/${encodeURIComponent(item.name)}`)
										return MiniflareResponse.json({
											name: item.name,
											'dist-tags': item.tags,
											versions: Object.fromEntries(
												[...fixtures.values()]
													.filter(
														(other) => other.registry === item.registry && other.name === item.name,
													)
													.map((other) => [other.version, other.metadata]),
											),
											readme: '# Registry README\nRead before choosing a version.',
										})
									if (
										request.url ===
										`${item.registry}/${encodeURIComponent(item.name)}/${item.version}`
									)
										return MiniflareResponse.json(item.metadata)
									if (
										request.url ===
										`${item.registry}/${encodeURIComponent(item.name)}/-/${item.version}.tgz`
									)
										return new MiniflareResponse(item.bytes)
									if (
										request.url ===
										`${item.registry}/-/package/${encodeURIComponent(item.name)}/dist-tags`
									)
										return MiniflareResponse.json(item.tags)
								}
								if (url.pathname === '/redirect.tgz')
									return new MiniflareResponse(null, {
										status: 302,
										headers: { Location: 'https://unexpected.example/file.tgz' },
									})
								return new MiniflareResponse('Not found', { status: 404 })
							},
						},
					},
				},
			],
		})
		const address = await runtime.ready
		origin = new URL(address.href)
		db = connect(await runtime.getD1Database('DB'))
	}

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'pluxel-market-'))
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
		const migrationEntries = await readdir(new URL('../migrations/', import.meta.url))
		const files = migrationEntries.filter((name) => name.endsWith('.sql')).sort()
		for (const file of files) {
			const migration = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')
			await binding.batch(
				migration
					.split('--> statement-breakpoint')
					.filter((statement) => statement.trim())
					.map((statement) => binding.prepare(statement)),
			)
		}
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
			db.delete(audits),
			db.delete(releases),
			db.delete(notifications),
			db.delete(packages),
		])
		fixtures.clear()
		requests.length = 0
		github = { status: 200, body: { full_name: 'unverified/claim', stargazers_count: 42 } }
	})

	function admin(auth: string = token) {
		return newHttpBatchRpcSession<MarketAdmin>(
			new Request(new URL('/admin', origin).href, { headers: { Authorization: `Bearer ${auth}` } }),
		)
	}
	function get(path: string, headers?: Record<string, string>) {
		return fetch(new URL(path, origin).href, { headers })
	}
	async function getJson(path: string, headers?: Record<string, string>) {
		const response = await get(path, headers)
		expect(response.status).toBe(200)
		return response.json()
	}
	function notify(value: unknown = selected) {
		return fetch(new URL('/v1/notifications', origin).href, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(value),
		})
	}
	const releasePath = `/v1/packages/${encodeURIComponent(selected.name)}/releases/${selected.version}`

	it('fetches and verifies npm bytes before publishing a browsable, cacheable exact release', async () => {
		const item = await fixture()
		using session = admin()
		const indexed = await session.refresh(selected)
		expect(indexed).toMatchObject({
			status: 'indexed',
			release: { ...selected, integrity: item.integrity, provenance: { status: 'missing' } },
		})
		expect(requests).toHaveLength(3)
		const listing = await get('/v1/packages')
		expect(await listing.json()).toMatchObject({
			packages: [
				{
					name: selected.name,
					description: `Package ${selected.name}`,
					latest: '1.0.0',
					repository: 'https://github.com/unverified/claim',
					indexedVersions: 1,
				},
			],
			nextCursor: null,
		})
		const response = await get(releasePath)
		expect(await response.json()).toMatchObject({
			...selected,
			integrity: item.integrity,
			peerDependencies: { '@pluxel/core': '^1.0.0' },
		})
		const unchanged = await get(releasePath, { 'If-None-Match': response.headers.get('ETag')! })
		expect(unchanged.status).toBe(304)
		expect(await unchanged.text()).toBe('')
		expect(requests).toHaveLength(3)
	})

	it('authenticates administration and bounds RPC and notification input', async () => {
		using denied = admin('wrong-token')
		await expect(denied.refresh(selected)).rejects.toThrow(/401/)
		expect(requests).toHaveLength(0)
		for (const invalid of [
			{ ...selected, version: '^1.0.0' },
			{ ...selected, name: '../escape' },
			{ ...selected, repository: 'https://github.com/claim' },
		]) {
			await expect(notify(invalid)).resolves.toMatchObject({ status: 400 })
		}
		await expect(
			notify({ ...selected, registry: 'https://untrusted.example' }),
		).resolves.toMatchObject({ status: 422 })
		await expect(notify({ ...selected, padding: 'x'.repeat(5000) })).resolves.toMatchObject({
			status: 413,
		})
		const huge = await fetch(new URL('/admin', origin).href, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: 'x'.repeat(70_000),
		})
		expect(huge.status).toBe(413)
		expect(await db.select().from(notifications)).toHaveLength(0)
	})

	it('deduplicates durable notification receipts and reports the unavailable native proof gate honestly', async () => {
		const [first, second] = await Promise.all([notify(), notify()])
		expect([first.status, second.status]).toEqual([202, 202])
		const accepted = await first.json()
		expect(await second.json()).toEqual(accepted)
		using processing = admin()
		expect(await processing.processNotifications()).toEqual({ processed: 1 })
		const response = await get(first.headers.get('Location')!)
		const done = (await response.json()) as Receipt
		expect(done).toMatchObject({
			...selected,
			status: 'failed',
			attempts: 1,
			code: 'provenance-runtime-unsupported',
		})
		expect(done).not.toHaveProperty('diagnostic')
		const replay = await notify()
		expect(replay.status).toBe(200)
		expect(await replay.json()).toEqual(done)
		using retry = admin()
		expect(await retry.retryNotification(done.id)).toEqual({
			status: 'unavailable',
			code: 'provenance-runtime-unsupported',
		})
		expect(requests).toHaveLength(0)
		expect(await db.select().from(releases)).toHaveLength(0)
	})

	it('never downgrades a present proof, follows redirects, or fetches arbitrary tarball origins', async () => {
		const item = await fixture()
		const dist = item.metadata.dist as Record<string, unknown>
		dist.attestations = { url: `${registry}/-/npm/v1/attestations/example` }
		using proof = admin()
		expect(await proof.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'provenance-runtime-unsupported',
		})
		expect(requests).toHaveLength(1)
		delete dist.attestations
		dist.tarball = 'https://localhost/private.tgz'
		using outside = admin()
		expect(await outside.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'disallowed-npm-url',
		})
		dist.tarball = `${registry}/redirect.tgz`
		using redirect = admin()
		expect(await redirect.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'npm-redirect',
		})
		expect(
			requests.some((url) => url.includes('unexpected.example') || url.includes('localhost')),
		).toBe(false)
		expect(await db.select().from(packages)).toHaveLength(0)
	})

	it('rejects digest mismatches, missing export files and unsafe tar paths before writing catalog state', async () => {
		const item = await fixture()
		;(item.metadata.dist as Record<string, unknown>).integrity = `sha512-${'A'.repeat(86)}==`
		using corrupt = admin()
		expect(await corrupt.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'integrity-mismatch',
		})
		await fixture(selected.name, { manifest: { exports: { '.': './dist/missing.mjs' } } })
		using missing = admin()
		expect(await missing.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'missing-export-file',
		})
		await fixture(selected.name, {
			extra: [{ header: { name: 'package/../escape', size: 0, type: 'file' }, body: '' }],
		})
		using unsafe = admin()
		expect(await unsafe.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'invalid-tarball-path',
		})
		await fixture(selected.name, {
			extra: [
				{
					header: {
						name: 'package/linked.mjs',
						type: 'symlink',
						linkname: 'dist/index.mjs',
						size: 0,
					},
				},
			],
		})
		using linked = admin()
		expect(await linked.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'invalid-tarball-entry',
		})
		expect(await db.select().from(packages)).toHaveLength(0)
		expect(await db.select().from(audits)).toHaveLength(0)
	})

	it('atomically admits one byte identity when conflicting first releases race', async () => {
		const first = {
			...selected,
			tarball: `${registry}/first.tgz`,
			integrity: 'first-digest',
			checkedAt: 1,
			provenance: { status: 'missing' as const },
			peerDependencies: {},
			pluginPackages: {},
			readme: null,
			license: null,
		}
		const second = {
			...first,
			tarball: `${registry}/second.tgz`,
			integrity: 'second-digest',
			checkedAt: 2,
		}
		const outcomes = await Promise.allSettled([
			commitRelease(db, first, {
				description: 'first',
				repository: null,
				metadataVersion: '1.0.0',
				readme: null,
				license: null,
				distTags: {},
				observedAt: 1,
			}),
			commitRelease(db, second, {
				description: 'second',
				repository: null,
				metadataVersion: '1.0.0',
				readme: null,
				license: null,
				distTags: {},
				observedAt: 2,
			}),
		])
		expect(outcomes.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
		const [stored] = await db.select().from(releases)
		expect(await db.select().from(packages)).toMatchObject([
			{ description: stored.integrity === 'first-digest' ? 'first' : 'second' },
		])
		expect(await db.select().from(audits)).toHaveLength(1)
	})

	it('rejects changed bytes for an indexed version without overwriting its observation or audit', async () => {
		const original = await fixture()
		using first = admin()
		expect(await first.refresh(selected)).toMatchObject({ status: 'indexed' })
		const conflicting = await fixture(selected.name, { manifest: { description: 'Changed bytes' } })
		conflicting.tags = { latest: '9.0.0' }
		using second = admin()
		expect(await second.refresh(selected)).toMatchObject({
			status: 'failed',
			code: 'immutable-release-conflict',
		})
		const response = await get(releasePath)
		expect(await response.json()).toMatchObject({ integrity: original.integrity })
		expect(await db.select().from(packages)).toMatchObject([
			{ description: `Package ${selected.name}`, distTags: { latest: '1.0.0' } },
		])
		expect(await db.select().from(audits)).toHaveLength(1)
	})

	it('preserves actual latest tags, paginates in the database, and excludes hidden packages before paging', async () => {
		for (const name of ['@example/aa', '@example/ab', '@example/ac']) {
			const item = await fixture(name)
			item.tags = { latest: '2.0.0' }
			using session = admin()
			expect(await session.refresh({ ...selected, name })).toMatchObject({ status: 'indexed' })
		}
		const older = await fixture('@example/aa', { version: '1.1.0' })
		older.tags = { latest: '2.0.0' }
		using another = admin()
		expect(
			await another.refresh({ ...selected, name: older.name, version: older.version }),
		).toMatchObject({ status: 'indexed' })
		using hidden = admin()
		expect(
			await hidden.setVisibility({
				registry,
				name: '@example/ab',
				expectedRevision: 1,
				hidden: true,
			}),
		).toMatchObject({ status: 'updated' })
		const firstResponse = await get('/v1/packages?query=%40example&limit=1')
		expect(firstResponse.status).toBe(200)
		const first = (await firstResponse.json()) as PackagePage
		expect(first.packages).toMatchObject([
			{ name: '@example/aa', latest: '2.0.0', indexedVersions: 2 },
		])
		const secondResponse = await get(
			`/v1/packages?query=%40example&limit=1&cursor=${first.nextCursor}`,
		)
		const second = (await secondResponse.json()) as PackagePage
		expect(second.packages).toMatchObject([{ name: '@example/ac', indexedVersions: 1 }])
		expect(second.nextCursor).toBeNull()
		await expect(get(`/v1/packages?query=other&cursor=${first.nextCursor}`)).resolves.toMatchObject(
			{ status: 400 },
		)
		await expect(get('/v1/packages/%40example%2Faa/releases/2.0.0')).resolves.toMatchObject({
			status: 404,
		})
		await expect(get('/v1/packages/%40example%2Fab/releases/1.0.0')).resolves.toMatchObject({
			status: 404,
		})
		const escaped = await get('/v1/packages?query=%25')
		expect(await escaped.json()).toMatchObject({ packages: [] })
		const versionsResponse = await get('/v1/packages/%40example%2Faa/releases?limit=1')
		const versions = (await versionsResponse.json()) as {
			releases: { version: string }[]
			nextCursor: string
		}
		expect(versions.releases).toMatchObject([{ version: '1.0.0' }])
		const nextVersions = await get(
			`/v1/packages/%40example%2Faa/releases?cursor=${versions.nextCursor}`,
		)
		expect(await nextVersions.json()).toMatchObject({
			releases: [{ version: '1.1.0' }],
			nextCursor: null,
			coverage: 'indexed-only',
		})
	})

	it('makes concurrent visibility changes compare revisions and creates only the winning audit', async () => {
		await fixture()
		using session = admin()
		await session.refresh(selected)
		using first = admin()
		using second = admin()
		const input = { registry, name: selected.name, expectedRevision: 1, hidden: true }
		const results = await Promise.all([first.setVisibility(input), second.setVisibility(input)])
		expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'updated'])
		expect(await db.select().from(audits)).toHaveLength(2)
		using refresh = admin()
		await refresh.refresh(selected)
		await expect(get(releasePath)).resolves.toMatchObject({ status: 404 })
		expect(await db.select().from(packages)).toMatchObject([{ hidden: true, revision: 2 }])
	})

	it('rejects stale leases and bounds retries including a crashed final attempt', async () => {
		const original = await enqueue(db, selected, 0)
		const [a, b] = await Promise.all([claim(db, original.id, 0), claim(db, original.id, 0)])
		const first = a ?? b
		expect([a, b].filter(Boolean)).toHaveLength(1)
		const recovered = await claim(db, original.id, 60_000)
		expect(recovered?.attempts).toBe(2)
		expect(
			await failAttempt(db, first!, new MarketError('network', 'Temporary', 502, true), 60_001),
		).toBe(false)
		expect(
			await failAttempt(db, recovered!, new MarketError('network', 'Temporary', 502, true), 60_001),
		).toBe(true)
		const stored = await db
			.select()
			.from(notifications)
			.where(eq(notifications.id, original.id))
			.get()
		expect(stored).toMatchObject({ status: 'pending', attempts: 2, nextAttemptAt: 180_001 })
		expect(await claim(db, original.id, 180_000)).toBeNull()
		const final = await claim(db, original.id, 180_001)
		expect(final?.attempts).toBe(maxAttempts)
		expect(await pendingNotifications(db, 240_001)).toEqual([])
		expect(await db.select().from(notifications)).toMatchObject([
			{ status: 'failed', code: 'attempts-exhausted' },
		])
	})

	it('enforces per-package notification capacity atomically and still returns duplicate receipts', async () => {
		const responses = await Promise.all(
			Array.from({ length: 12 }, (_, index) => notify({ ...selected, version: `1.0.${index}` })),
		)
		expect(responses.filter((response) => response.status === 202)).toHaveLength(10)
		expect(responses.filter((response) => response.status === 429)).toHaveLength(2)
		const first = (await responses.find((response) => response.status === 202)!.json()) as Receipt
		await expect(
			notify({ registry, name: first.name, version: first.version }),
		).resolves.toMatchObject({ status: 202 })
		expect(await db.select().from(notifications)).toHaveLength(10)
	})

	it('restores accepted receipts after recreating the Worker', async () => {
		const accepted = await notify()
		const body = await accepted.json()
		const location = accepted.headers.get('Location')!
		await runtime.dispose()
		await start()
		const restored = await get(location)
		expect(await restored.json()).toEqual(body)
		const duplicate = await notify()
		expect(await duplicate.json()).toEqual(body)
	})

	it('keeps same-name packages, notifications, and curation scoped to their real registry', async () => {
		const publicItem = await fixture('@pluxel/plugin-example')
		const privateItem = await fixture(publicItem.name, {
			registry: privateRegistry,
			manifest: { description: 'Private replacement', official: true },
		})
		const publicCoordinate = { ...selected, name: publicItem.name }
		const privateCoordinate = { ...publicCoordinate, registry: privateRegistry }
		{
			using publicAdmin = admin()
			expect(await publicAdmin.refresh(publicCoordinate)).toMatchObject({ status: 'indexed' })
		}
		{
			using privateAdmin = admin()
			expect(await privateAdmin.refresh(privateCoordinate)).toMatchObject({ status: 'indexed' })
		}
		const path = `/v1/packages/${encodeURIComponent(publicItem.name)}/releases/1.0.0`
		expect(await getJson(path)).toMatchObject({
			registry,
			integrity: publicItem.integrity,
		})
		await expect(
			get(`${path}?registry=${encodeURIComponent(privateRegistry)}`),
		).resolves.toMatchObject({ status: 404 })
		const privateRead = await get(`${path}?registry=${encodeURIComponent(privateRegistry)}`, {
			Authorization: `Bearer ${token}`,
		})
		expect(privateRead.headers.get('Cache-Control')).toBe('no-store')
		expect(await privateRead.json()).toMatchObject({
			registry: privateRegistry,
			integrity: privateItem.integrity,
		})
		expect(await getJson('/v1/packages')).toMatchObject({
			packages: [{ registry, name: publicItem.name, official: false }],
		})
		const both = (await getJson('/v1/packages', {
			Authorization: `Bearer ${token}`,
		})) as PackagePage
		expect(both.packages).toHaveLength(2)
		expect(new Set(both.packages.map((item) => item.registry))).toEqual(
			new Set([registry, privateRegistry]),
		)
		const first = await notify(publicCoordinate)
		const publicReceipt = (await first.json()) as Receipt
		const submitPrivate = (authorization?: string) =>
			fetch(new URL('/v1/notifications', origin), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(authorization ? { Authorization: authorization } : {}),
				},
				body: JSON.stringify(privateCoordinate),
			})
		await expect(submitPrivate()).resolves.toMatchObject({ status: 401 })
		const accepted = await submitPrivate('Bearer notify-private')
		const privateReceipt = (await accepted.json()) as Receipt
		expect(privateReceipt.id).not.toBe(publicReceipt.id)
		expect(privateReceipt.registry).toBe(privateRegistry)
		await expect(get(`/v1/notifications/${privateReceipt.id}`)).resolves.toMatchObject({
			status: 404,
		})
		expect(
			await getJson(`/v1/notifications/${privateReceipt.id}`, {
				Authorization: 'Bearer notify-private',
			}),
		).toEqual(privateReceipt)
		await expect(
			get('/v1/packages', { Authorization: 'Bearer notify-private' }),
		).resolves.toMatchObject({ status: 401 })
		const capabilities = JSON.stringify(await getJson('/v1'))
		expect(capabilities).not.toContain(privateRegistry)
		expect(capabilities).not.toContain('read-private')
		expect(capabilities).not.toContain('notify-private')
		privateItem.metadata.dist = {
			...(privateItem.metadata.dist as object),
			tarball:
				publicItem.metadata.dist && (publicItem.metadata.dist as { tarball: string }).tarball,
		}
		{
			using rejected = admin()
			expect(await rejected.refresh(privateCoordinate)).toMatchObject({
				status: 'failed',
				code: 'disallowed-npm-url',
			})
		}
	})

	it('searches indexed descriptions and market tags, filters curation, and preserves it across refreshes', async () => {
		await fixture('@pluxel/plugin-example', {
			manifest: {
				description: 'HTTP transport integration',
				official: true,
				category: 'forged',
				tags: ['forged'],
			},
		})
		const identity = { registry, name: '@pluxel/plugin-example' }
		{
			using indexing = admin()
			await indexing.refresh({ ...identity, version: '1.0.0' })
		}
		{
			using curation = admin()
			expect(
				await curation.setMetadata({
					...identity,
					expectedRevision: 1,
					official: true,
					category: 'integration',
					tags: ['network', 'http'],
				}),
			).toMatchObject({ status: 'updated', record: { revision: 2, tags: ['http', 'network'] } })
		}
		const beforeSearch = requests.length
		for (const query of ['transport', 'netw', 'HTTP transport', 'pluxel example']) {
			const response = await get(
				`/v1/packages?query=${encodeURIComponent(query)}&official=true&category=integration&tag=http`,
			)
			expect(response.status).toBe(200)
			expect(await response.json()).toMatchObject({
				packages: [
					{ ...identity, official: true, category: 'integration', tags: ['http', 'network'] },
				],
			})
		}
		for (const query of ['forged', 'missing', '%']) {
			expect(await getJson(`/v1/packages?query=${encodeURIComponent(query)}`)).toMatchObject({
				packages: [],
			})
		}
		expect(requests).toHaveLength(beforeSearch)
		expect(await getJson('/v1/facets')).toEqual({
			categories: [{ value: 'integration', count: 1 }],
			tags: [
				{ value: 'http', count: 1 },
				{ value: 'network', count: 1 },
			],
		})
		{
			using stale = admin()
			expect(
				await stale.setMetadata({
					...identity,
					expectedRevision: 1,
					official: false,
					category: null,
					tags: [],
				}),
			).toEqual({ status: 'conflict', currentRevision: 2 })
		}
		{
			using refresh = admin()
			await refresh.refresh({ ...identity, version: '1.0.0' })
		}
		{
			using read = admin()
			expect(await read.getPackage(identity)).toMatchObject({
				revision: 2,
				official: true,
				category: 'integration',
				tags: ['http', 'network'],
			})
		}
		{
			using audit = admin()
			const changes = await audit.recentChanges(identity)
			expect(changes.filter((change) => change.action === 'metadata')).toMatchObject([
				{
					revision: 2,
					changes: { official: true, category: 'integration', tags: ['http', 'network'] },
				},
			])
		}
		{
			using hidden = admin()
			await hidden.setVisibility({ ...identity, expectedRevision: 2, hidden: true })
		}
		expect(await getJson('/v1/facets')).toEqual({ categories: [], tags: [] })
		expect(await getJson('/v1/packages?query=network')).toMatchObject({ packages: [] })
	})

	it('lists actionable notifications with stable tied-time paging and query-bound cursors', async () => {
		const rows = await Promise.all(
			['1.0.0', '1.1.0', '1.2.0'].map((version) => enqueue(db, { ...selected, version }, 100)),
		)
		const task = await claim(db, rows[0].id, 100)
		await failAttempt(
			db,
			task!,
			new MarketError('invalid-package', 'Fix the package before a bounded manual retry', 422),
			101,
		)
		let next: string | null = null
		let firstCursor: string | undefined
		const seen: string[] = []
		do {
			using session = admin()
			const page = await session.listNotifications({
				name: selected.name,
				limit: 1,
				...(next ? { cursor: next } : {}),
			})
			expect(page.notifications).toHaveLength(1)
			seen.push(page.notifications[0].id)
			expect(page.notifications[0]).not.toHaveProperty('leaseToken')
			next = page.nextCursor
			firstCursor ??= next ?? undefined
		} while (next)
		expect(new Set(seen)).toEqual(new Set(rows.map((row) => row.id)))
		{
			using mismatch = admin()
			await expect(
				mismatch.listNotifications({ status: 'failed', cursor: firstCursor }),
			).rejects.toThrow(/cursor|query/i)
		}
		{
			using failed = admin()
			expect(
				await failed.listNotifications({ registry, status: 'failed', code: 'invalid-package' }),
			).toMatchObject({
				notifications: [
					{
						id: task!.id,
						diagnostic: 'Fix the package before a bounded manual retry',
						retry: 'available',
					},
				],
				nextCursor: null,
			})
		}
		{
			using retry = admin()
			expect(await retry.retryNotification(task!.id)).toMatchObject({
				status: 'queued',
				receipt: { attempts: 1 },
			})
		}
		{
			using changed = admin()
			expect(await changed.getNotification(task!.id)).toMatchObject({
				status: 'pending',
				retry: 'not-failed',
			})
		}
		{
			using invalid = admin()
			await expect(invalid.listNotifications({ limit: 51 })).rejects.toThrow(/limit/)
		}
	})

	it('observes legacy npm packages for browsing without fabricating a checked release or provenance', async () => {
		const item = await fixture('@pluxel/legacy', {
			manifest: { peerDependencies: { '@pluxel/runtime': '^1.0.0' } },
		})
		Object.assign(item.metadata, {
			description: 'Public legacy plugin',
			repository: { url: 'git+https://github.com/unverified/claim.git' },
			license: 'MIT',
		})
		Object.assign(item.metadata.dist as object, {
			attestations: { url: `${registry}/attestation` },
		})
		{
			using observe = admin()
			expect(await observe.observe({ registry, name: item.name })).toMatchObject({
				status: 'observed',
			})
		}
		expect(await getJson('/v1/packages?query=legacy')).toMatchObject({
			packages: [
				{
					registry,
					name: item.name,
					indexedVersions: 0,
					repository: 'https://github.com/unverified/claim',
					repositoryStars: null,
				},
			],
		})
		const detail = await getJson(`/v1/packages/${encodeURIComponent(item.name)}`)
		expect(detail).toMatchObject({
			metadataVersion: '1.0.0',
			readme: { text: '# Registry README\nRead before choosing a version.', truncated: false },
			license: 'MIT',
			indexedVersions: 0,
		})
		await expect(
			get(`/v1/packages/${encodeURIComponent(item.name)}/releases/1.0.0`),
		).resolves.toMatchObject({ status: 404 })
		{
			using refresh = admin()
			expect(await refresh.refresh({ registry, name: item.name, version: '1.0.0' })).toMatchObject({
				status: 'failed',
				code: 'provenance-runtime-unsupported',
			})
		}
		expect(await db.select().from(releases)).toEqual([])
		expect(await db.select().from(notifications)).toEqual([])
	})

	it('stores real repository observations and packaged README previews without conflating provenance or unknown stars', async () => {
		const text = '# Plugin README\n<script>never execute this</script>'
		await fixture(selected.name, {
			manifest: { license: 'MIT' },
			extra: [
				{ header: { name: 'package/README.md', type: 'file', size: text.length }, body: text },
			],
		})
		{
			using refresh = admin()
			await refresh.refresh(selected)
		}
		expect(await getJson(releasePath)).toMatchObject({
			readme: { text, truncated: false },
			license: 'MIT',
			provenance: { status: 'missing' },
		})
		const identity = { registry, name: selected.name }
		{
			using stars = admin()
			expect(await stars.refreshRepository(identity)).toMatchObject({
				status: 'updated',
				stars: 42,
			})
		}
		const listing = (await getJson('/v1/packages')) as PackagePage
		expect(listing.packages[0]).toMatchObject({
			repositoryStars: 42,
			repositoryObservedAt: expect.any(Number),
		})
		github.status = 429
		{
			using limited = admin()
			expect(await limited.refreshRepository(identity)).toMatchObject({
				status: 'failed',
				code: 'repository-unavailable',
				retryable: true,
			})
		}
		{
			using refreshing = admin()
			await refreshing.refresh(selected)
		}
		const after = (await getJson('/v1/packages')) as PackagePage
		expect(after.packages[0].repositoryStars).toBe(42)
		expect(after.packages[0].repositoryObservedAt).toBe(listing.packages[0].repositoryObservedAt)
		const count = requests.length
		await getJson('/v1/packages')
		await getJson('/v1/packages?query=plugin')
		expect(requests).toHaveLength(count)
	})
})

import { existsSync } from 'node:fs'
import { mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BasePlugin, Plugin } from '@pluxel/core'
import { FontsConfig, FontsPlugin } from '@pluxel/fonts'
import { createTestHost } from '@pluxel/test'
import {
	defineHostApplication,
	envBinding,
	fileBinding,
	resolveHostApplication,
} from '@pluxel/host'
import { nodeModules } from '@pluxel/services/node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TypstConfig, TypstPlugin, type TypstFiles, type TypstSession } from '../src/index.ts'

@Plugin()
class TypstConsumer extends BasePlugin {
	constructor(
		readonly typst: TypstPlugin,
		readonly fonts: FontsPlugin,
	) {
		super()
	}
}

const deploymentFont = [
	'/usr/share/fonts/dejavu/DejaVuSans.ttf',
	'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
].find((path) => existsSync(path))
const roots: string[] = []
async function template(
	source = '#let a = json("/inputs/a.json")\n#let b = json("/inputs/b.json")\n#assert(a.n + b.n == 3)\nReport',
): Promise<{ root: string; entry: string }> {
	const root = await mkdtemp(join(tmpdir(), 'typst-plugin-test-'))
	roots.push(root)
	await writeFile(join(root, 'main.typ'), source)
	return { root, entry: 'main.typ' }
}
const files = {
	'/inputs/a.json': { kind: 'json', value: { n: 1 } },
	'/inputs/b.json': { kind: 'json', value: { n: 2 } },
} satisfies TypstFiles

async function fixture() {
	const host = await createTestHost({
		services: [nodeModules()],
	})
	try {
		await host.commit((change) => {
			change.catalog.add([FontsPlugin, TypstPlugin, TypstConsumer])
			change.start([FontsPlugin, TypstPlugin, TypstConsumer])
		})
		return host
	} catch (cause) {
		await host.dispose()
		throw cause
	}
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('TypstPlugin real host and worker', () => {
	it.skipIf(!deploymentFont)(
		'applies file budgets and env overrides without Workbench or Persistence',
		async () => {
			const source = await template()
			await writeFile(
				join(source.root, 'typst.json'),
				JSON.stringify({ maxSessions: 2, maxInputBytes: 1024 }),
			)
			const application = defineHostApplication(() => ({
				plugins: [FontsPlugin, TypstPlugin, TypstConsumer],
				envBindings: [
					envBinding(FontsPlugin, {
						config: { schema: FontsConfig, mapping: { files: 'FONT_FILES' } },
					}),
					envBinding(TypstPlugin, {
						config: { schema: TypstConfig, mapping: { maxSessions: 'TYPST_SESSIONS' } },
					}),
				],
				fileBindings: [
					fileBinding(TypstPlugin, {
						config: { schema: TypstConfig, path: './typst.json' },
					}),
				],
			}))
			const resolved = await resolveHostApplication(application, {
				root: source.root,
				mode: 'test',
				env: { TYPST_SESSIONS: '1', FONT_FILES: JSON.stringify([deploymentFont]) },
				bindings: {},
			})
			await using host = await createTestHost({
				services: [nodeModules()],
				configRecords: resolved.configRecords,
			})
			await host.commit((change) => {
				change.catalog.add([FontsPlugin, TypstPlugin, TypstConsumer])
				change.start([FontsPlugin, TypstPlugin, TypstConsumer])
			})
			const consumer = host.require(TypstConsumer)
			expect(consumer.fonts.portableFonts.fonts).toHaveLength(1)
			const typst = consumer.typst
			await using session = await typst.open(source)
			await expect(typst.open(source)).rejects.toMatchObject({ code: 'BUSY' })
			const compiled = await session.update({ files })
			expect(
				Buffer.from(await session.exportPdf(compiled.revision))
					.subarray(0, 5)
					.toString(),
			).toBe('%PDF-')
			await expect(
				session.update({
					files: {
						'/inputs/large.txt': { kind: 'text', text: 'x'.repeat(1025) },
					},
				}),
			).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
			const patched = await host.config.patch(TypstPlugin, { maxSessions: 3 })
			expect(patched.ok).toBe(false)
		},
		30_000,
	)

	it('compiles mixed files, replaces inputs, recovers failed updates, and expires only older successful revisions', async () => {
		await using host = await fixture()
		const source = await template()
		const disk = join(source.root, 'value.json')
		await writeFile(disk, '{"n":2}')
		await using session = await host.require(TypstConsumer).typst.open(source)
		const first = await session.update({
			files: { ...files, '/inputs/b.json': { kind: 'file', path: disk } },
		})
		expect(first.preview.data.byteLength).toBeGreaterThan(0)
		expect(first.preview.navigation.points.some((point) => point.path === 'main.typ')).toBe(true)
		const image = await session.renderPage({ revision: first.revision, page: 1, scale: 1 })
		expect(Buffer.from(image.data).subarray(0, 8)).toEqual(
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		)
		await expect(session.renderPage({ revision: first.revision, page: 999 })).rejects.toMatchObject(
			{ code: 'INVALID_INPUT' },
		)
		const originalPdf = await session.exportPdf(first.revision)
		expect(Buffer.from(originalPdf).subarray(0, 5).toString()).toBe('%PDF-')
		await expect(
			session.update({ files: { '/inputs/a.json': files['/inputs/a.json'] } }),
		).rejects.toMatchObject({ code: 'COMPILE_FAILED' })
		expect(await session.exportPdf(first.revision)).toEqual(originalPdf)
		const recoveredImage = await session.renderPage({ revision: first.revision, page: 1, scale: 1 })
		expect(recoveredImage.data).toEqual(image.data)
		const second = await session.update({ files })
		expect(second.revision).toBe(first.revision + 1)
		await expect(session.exportPdf(first.revision)).rejects.toMatchObject({
			code: 'STALE_REVISION',
		})
	}, 30_000)

	it('serializes updates while an accepted PDF export retains its revision', async () => {
		await using host = await fixture()
		await using session = await host.require(TypstConsumer).typst.open(await template())
		const first = await session.update({ files })
		const expected = await session.exportPdf(first.revision)
		const exporting = session.exportPdf(first.revision)
		const updating = session.update({ files })
		const next = session.update({ files })
		expect(await exporting).toEqual(expected)
		const secondResult = await updating
		const thirdResult = await next
		expect(secondResult.revision).toBe(first.revision + 1)
		expect(thirdResult.revision).toBe(first.revision + 2)
	}, 30_000)

	it('await using closes sessions, releases capacity, and rejects cached handles', async () => {
		await using host = await fixture()
		const typst = host.require(TypstConsumer).typst
		let cached!: TypstSession
		{
			await using session = await typst.open(await template())
			cached = session
			await session.update({ files })
		}
		await expect(cached.update({ files })).rejects.toMatchObject({ code: 'CLOSED' })
		await cached.dispose()
		await using replacement = await typst.open(await template())
		const result = await replacement.update({ files })
		expect(result.revision).toBe(1)
	}, 30_000)

	it.each(['consumer', 'provider'] as const)(
		'closes cached sessions when the %s stops',
		async (owner) => {
			await using host = await fixture()
			const session = await host.require(TypstConsumer).typst.open(await template())
			await session.update({ files })
			await host.stop(owner === 'consumer' ? TypstConsumer : TypstPlugin)
			await expect(session.update({ files })).rejects.toMatchObject({ code: 'CLOSED' })
			await session.dispose()
		},
		30_000,
	)

	it('cancels queued updates and removes private resources after disposal', async () => {
		await using host = await fixture()
		const temporaryRoot = await mkdtemp(join(tmpdir(), 'typst-resource-check-'))
		roots.push(temporaryRoot)
		// Session resources must be checked independently of other files' concurrent workers.
		for (const key of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(key, temporaryRoot)
		try {
			const session = await host.require(TypstConsumer).typst.open(await template())
			const first = session.update({ files })
			const controller = new AbortController()
			const reason = new Error('cancel queued document')
			const second = session.update({ files, signal: controller.signal })
			controller.abort(reason)
			await expect(second).rejects.toBe(reason)
			await first
			const activeEntries = await readdir(temporaryRoot)
			expect(activeEntries.filter((name) => name.startsWith('pluxel-typst-'))).toHaveLength(1)
			await session.dispose()
			const finalEntries = await readdir(temporaryRoot)
			const remaining = finalEntries.filter((name) => name.startsWith('pluxel-typst-'))
			expect(remaining).toEqual([])
		} finally {
			vi.unstubAllEnvs()
		}
	}, 30_000)
	it('reads a 16 MiB disk JSON with a long table and SVG through the actual worker', async () => {
		await using host = await fixture()
		const inputRoot = await mkdtemp(join(tmpdir(), 'typst-large-input-'))
		roots.push(inputRoot)
		const inputPath = join(inputRoot, 'large.json')
		const payloadBytes = 16 * 1024 * 1024
		// Construct the source incrementally: this test never parses the disk JSON in JS.
		{
			await using file = await open(inputPath, 'w')
			await file.write('{"payload":"')
			const chunk = 'x'.repeat(256 * 1024)
			for (let i = 0; i < 64; i++) await file.write(chunk)
			await file.write('"}')
		}
		await using session = await host.require(TypstConsumer).typst.open(
			await template(`
 #let data = json("/inputs/large.json")
 #assert(data.payload.len() == ${payloadBytes})
 #image("/inputs/logo.svg", width: 20pt)
 #table(columns: 2, ..range(2000).map(i => str(i)))
`),
		)
		const rssBefore = process.memoryUsage.rss()
		let sampledPeakRss = rssBefore
		const sampler = setInterval(() => {
			sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage.rss())
		}, 5)
		const started = performance.now()
		let compiled
		try {
			compiled = await session.update({
				files: {
					'/inputs/large.json': { kind: 'file', path: inputPath },
					'/inputs/logo.svg': {
						kind: 'text',
						text: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
					},
				},
			})
		} finally {
			clearInterval(sampler)
		}
		const elapsedMs = performance.now() - started
		sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage.rss())
		const pdf = await session.exportPdf(compiled.revision)
		await writeFile(inputPath, '{"payload":"changed after update"}')
		expect(await session.exportPdf(compiled.revision)).toEqual(pdf)
		expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe('%PDF-')
		console.info(
			'Typst disk probe',
			JSON.stringify({
				payloadBytes,
				tableRows: 1000,
				elapsedMs: Math.round(elapsedMs),
				sampledPeakRssDeltaBytes: sampledPeakRss - rssBefore,
				vectorBytes: compiled.preview.data.byteLength,
				pdfBytes: pdf.byteLength,
			}),
		)
	}, 60_000)
})

it('replaces template sources and removes deleted imports in the same native session', async () => {
	await using host = await fixture()
	const source = await template('#include "shared.typ"')
	await writeFile(join(source.root, 'shared.typ'), 'Before')
	await using session = await host.require(TypstConsumer).typst.open(source)
	const first = await session.update({ files: {} })
	await writeFile(join(source.root, 'shared.typ'), 'After shared theme edit')
	const changed = await session.update({ template: source, files: {} })
	expect(changed.preview.sessionId).toBe(first.preview.sessionId)
	expect(changed.revision).toBe(first.revision + 1)
	expect(changed.preview.data).not.toEqual(first.preview.data)
	await rm(join(source.root, 'shared.typ'))
	await expect(session.update({ template: source, files: {} })).rejects.toMatchObject({
		code: 'COMPILE_FAILED',
	})
	await writeFile(join(source.root, 'shared.typ'), 'Repaired')
	expect(await session.update({ template: source, files: {} })).toMatchObject({
		revision: changed.revision + 1,
	})
})

it('preserves timeout reason, closes the interrupted native session and can reopen', async () => {
	await using host = await fixture()
	const typst = host.require(TypstConsumer).typst
	await using interrupted = await typst.open(await template('#for i in range(100000) { [x] }'))
	await expect(interrupted.update({ files: {}, timeoutMs: 50 })).rejects.toMatchObject({
		name: 'TimeoutError',
	})
	await expect(interrupted.update({ files: {} })).rejects.toMatchObject({ code: 'CLOSED' })
	await using recovered = await typst.open(await template('Recovered'))
	expect(await recovered.update({ files: {} })).toHaveProperty('preview')
})

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import type { FontsPlugin } from '@pluxel/plugin-fonts'
import {
	TypstError,
	type TypstPlugin,
	type TypstSession,
	type TypstCompiled,
} from '@pluxel/plugin-typst'
import type { JsonObject, WorkspaceSnapshot } from '../src/shared/contracts.js'
import { ArtifactStore } from '../src/backend/artifacts.js'
import { TemplateCompiler } from '../src/backend/compiler.js'
import { DocumentService, DOCUMENT_POLICY } from '../src/backend/documents.js'
import type { WorkspaceStore } from '../src/backend/store.js'

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
const target = (entry = 'a', projectId = 'project') => ({
	projectId,
	entry: `${entry}/${entry}.ts`,
})

/** Fault-injection harness for DocumentService ownership; backend.test exercises the native host. */
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), 'studio-documents-test-'))
	const artifactRoot = join(directory, 'artifacts')
	const documents = new Map<string, WorkspaceSnapshot>()
	for (const id of ['project', 'other'])
		documents.set(id, {
			project: { id, name: id, root: join(directory, id) },
			revision: 'one',
			config: { name: id, fonts: [] },
			assets: [],
			files: Object.fromEntries(
				['a', 'b', 'c', 'd', 'e'].flatMap((name) => [
					[`${name}/${name}.ts`, 'source'],
					[`${name}/main.typ`, 'layout'],
				]),
			),
		})
	const snapshot = vi.fn(async (id: string) => structuredClone(documents.get(id)!))
	const materialize = vi.fn(async (id: string, root: string) => {
		const document = await snapshot(id)
		for (const [path, content] of Object.entries(document.files)) {
			await mkdir(dirname(join(root, path)), { recursive: true })
			await writeFile(join(root, path), content)
		}
		return document
	})
	const store = { snapshot, materialize } as unknown as WorkspaceStore
	const registered = new Map<
		string,
		{ id: string; byteLength: number; resolvedFamilies: string[] }
	>()
	const fonts = {
		get portableFonts() {
			return { revision: 0, fonts: [...registered.values()] }
		},
		registerFromPath: vi.fn(async ({ path }: { path: string }) => {
			const bytes = await readFile(path)
			const id = bytes.toString()
			registered.set(id, { id, byteLength: bytes.byteLength, resolvedFamilies: [id] })
			return {
				families: [id],
				active: true,
				dispose() {
					registered.delete(id)
				},
			}
		}),
	} as unknown as FontsPlugin
	const sessions: Array<
		TypstSession & { closed: boolean; update: ReturnType<typeof vi.fn<TypstSession['update']>> }
	> = []
	let beforeUpdate:
		| ((session: TypstSession, input: Parameters<TypstSession['update']>[0]) => Promise<void>)
		| undefined
	let afterUpdate: ((session: TypstSession) => Promise<void>) | undefined
	let beforeOpen: ((root: string, fonts: string[]) => Promise<void>) | undefined
	const open = vi.fn(async ({ root }: { root: string }) => {
		await beforeOpen?.(root, [...registered.keys()])
		let revision = 0
		const session = {
			id: String(sessions.length + 1),
			closed: false,
			update: vi.fn<TypstSession['update']>(async (input) => {
				await beforeUpdate?.(session, input)
				const next = ++revision
				const result: TypstCompiled = {
					revision: next,
					diagnostics: [],
					preview: {
						sessionId: session.id,
						revision: next,
						format: 'vector',
						compilerVersion: '0.7.0',
						data: new Uint8Array([next]),
						navigation: { pages: [{ page: 1, width: 100, height: 120 }], outline: [], points: [] },
					},
				}
				await afterUpdate?.(session)
				return result
			}),
			renderPage: vi.fn<TypstSession['renderPage']>(async (input) => ({
				revision: input.revision,
				page: input.page,
				format: 'png',
				data: new Uint8Array([input.revision]),
				width: 200,
				height: 240,
				region: { x: 0, y: 0, width: 100, height: 120 },
			})),
			exportPdf: vi.fn<TypstSession['exportPdf']>(async () =>
				new TextEncoder().encode('%PDF-test'),
			),
			dispose: vi.fn(async () => {
				session.closed = true
			}),
			[Symbol.asyncDispose]: async () => {
				await session.dispose()
			},
		}
		sessions.push(session)
		return session
	})
	const typst = { open, ctx: { logger: { info: vi.fn() } } } as unknown as TypstPlugin
	const evaluate = vi
		.spyOn(TemplateCompiler.prototype, 'evaluate')
		.mockImplementation(async (_doc, entry, data) => ({
			entry,
			template: dirname(entry) + '/main.typ',
			name: dirname(entry),
			data,
			files: { '/inputs/data.json': { kind: 'json', value: data } },
		}))
	const describe = vi
		.spyOn(TemplateCompiler.prototype, 'describe')
		.mockImplementation(async (_doc, entry) => ({
			entry,
			template: dirname(entry) + '/main.typ',
			name: dirname(entry),
			fields: [],
			defaults: {},
		}))
	const artifacts = new ArtifactStore(artifactRoot)
	await artifacts.initialize()
	const service = new DocumentService(store, fonts, typst, artifacts)
	return {
		service,
		documents,
		sessions,
		snapshot,
		materialize,
		open,
		evaluate,
		describe,
		artifacts,
		artifactRoot,
		registered,
		setBeforeUpdate(fn: typeof beforeUpdate) {
			beforeUpdate = fn
		},
		setAfterUpdate(fn: typeof afterUpdate) {
			afterUpdate = fn
		},
		setBeforeOpen(fn: typeof beforeOpen) {
			beforeOpen = fn
		},
		async close() {
			await service.close()
			await artifacts.close()
			await rm(directory, { recursive: true, force: true })
		},
	}
}

it('requires explicit data, gives each success a unique revision, reuses native state and rejects superseded reads', async () => {
	const f = await fixture()
	try {
		await expect(f.service.compile(target() as never)).rejects.toMatchObject({
			code: 'INVALID_INPUT',
		})
		expect(f.open).not.toHaveBeenCalled()
		const data: JsonObject = { label: 'original' }
		const compiling = f.service.compile({ ...target(), data })
		data.label = 'mutated'
		const first = await compiling
		expect(first.data).toEqual({ label: 'original' })
		const preview = await f.service.getPreview(first)
		expect(preview.preview.data).toBeInstanceOf(Uint8Array)
		preview.preview.data[0] = 255
		const detached = await f.service.getPreview(first)
		expect(detached.preview.data[0]).toBe(1)
		const artifact = await f.service.renderPage({ ...first, page: 1 })
		const second = await f.service.compile({ ...target(), data: {} })
		expect(second.revision).not.toBe(first.revision)
		expect(f.open).toHaveBeenCalledTimes(1)
		const secondPreview = await f.service.getPreview(second)
		expect(secondPreview.preview.revision).toBe(2)
		await expect(f.service.renderPage({ ...first, page: 1 })).rejects.toMatchObject({
			code: 'REVISION_CONFLICT',
		})
		expect(await readFile(artifact.path)).toEqual(Buffer.from([1]))
	} finally {
		await f.close()
	}
})

it('retains the previous document for COMPILE_FAILED but revokes it after native success followed by a source conflict', async () => {
	const f = await fixture()
	try {
		const first = await f.service.compile({ ...target(), data: {} })
		f.setBeforeUpdate(async () => {
			throw new TypstError('COMPILE_FAILED', 'invalid layout', {
				diagnostics: [{ severity: 'error', message: 'layout error', path: 'a/main.typ' }],
			})
		})
		await expect(f.service.compile({ ...target(), data: {} })).rejects.toMatchObject({
			code: 'COMPILE_FAILED',
			diagnostics: [expect.objectContaining({ path: 'a/main.typ' })],
		})
		const retained = await f.service.getPreview(first)
		expect(retained.preview.revision).toBe(1)
		f.setBeforeUpdate(undefined)
		f.setAfterUpdate(async () => {
			f.documents.get('project')!.revision = 'changed'
		})
		await expect(f.service.compile({ ...target(), data: {} })).rejects.toMatchObject({
			code: 'REVISION_CONFLICT',
		})
		f.documents.get('project')!.revision = 'one'
		await expect(f.service.getPreview(first)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
		expect(f.open).toHaveBeenCalledTimes(1)
	} finally {
		await f.close()
	}
})

it('rejects a fifth busy record and allows independent documents to finish concurrently', async () => {
	const f = await fixture()
	const gates = [deferred(), deferred(), deferred(), deferred()]
	const entered = deferred()
	try {
		let count = 0
		f.evaluate.mockImplementation(async (_doc, entry, data) => {
			const index = entry.charCodeAt(0) - 'a'.charCodeAt(0)
			if (++count === 4) entered.resolve()
			await gates[index]!.promise
			return {
				entry,
				template: dirname(entry) + '/main.typ',
				name: dirname(entry),
				data,
				files: {},
			}
		})
		const compiling = ['a', 'b', 'c', 'd'].map((entry) =>
			f.service.compile({ ...target(entry), data: {} }),
		)
		await entered.promise
		await expect(f.service.describeDocument(target('e'))).rejects.toMatchObject({ code: 'BUSY' })
		gates[1]!.resolve()
		const independent = await compiling[1]!
		expect(independent.entry).toBe('b/b.ts')
		expect(f.open).toHaveBeenCalledTimes(1)
		for (const gate of gates) gate.resolve()
		await Promise.all(compiling)
	} finally {
		for (const gate of gates) gate.resolve()
		await f.close()
	}
})

it('evicts the least recently used idle document, including read accesses', async () => {
	const f = await fixture()
	try {
		const compiled = []
		for (const entry of ['a', 'b', 'c', 'd'])
			compiled.push(await f.service.compile({ ...target(entry), data: {} }))
		await f.service.getPreview(compiled[0]!)
		await f.service.compile({ ...target('e'), data: {} })
		await expect(f.service.getPreview(compiled[1]!)).rejects.toMatchObject({
			code: 'REVISION_CONFLICT',
		})
		const retained = await f.service.getPreview(compiled[0]!)
		expect(retained.entry).toBe('a/a.ts')
		expect(f.sessions[1]!.closed).toBe(true)
	} finally {
		await f.close()
	}
})

it('bounds the shared compile/describe queue and counts waiting time in its deadline', async () => {
	const f = await fixture()
	const gate = deferred()
	const entered = deferred()
	try {
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
		f.setBeforeUpdate(async () => {
			entered.resolve()
			await gate.promise
		})
		const first = f.service.compile({ ...target(), data: {} }).catch((error) => error)
		await entered.promise
		const queued = Array.from({ length: DOCUMENT_POLICY.maxQueuedUpdates }, () =>
			f.service.describeDocument(target()).catch((error) => error),
		)
		await expect(f.service.compile({ ...target(), data: {} })).rejects.toMatchObject({
			code: 'BUSY',
		})
		await vi.advanceTimersByTimeAsync(DOCUMENT_POLICY.deadlineMs + 1)
		for (const result of await Promise.all(queued))
			expect(result).toMatchObject({ code: 'DEADLINE_EXCEEDED' })
		expect(f.describe).not.toHaveBeenCalled()
		gate.resolve()
		expect(await first).toMatchObject({ code: 'DEADLINE_EXCEEDED' })
		expect(f.sessions[0]!.update).toHaveBeenCalledTimes(1)
	} finally {
		gate.resolve()
		vi.useRealTimers()
		await f.close()
	}
})

it('keeps a borrowed old project snapshot readable until a blocked open settles', async () => {
	const f = await fixture()
	const gate = deferred()
	const entered = deferred<string>()
	try {
		f.setBeforeOpen(async (root) => {
			entered.resolve(root)
			await gate.promise
			expect(await readFile(join(root, 'a/main.typ'), 'utf8')).toBe('layout')
		})
		const first = f.service.compile({ ...target(), data: {} }).catch((error) => error)
		const oldRoot = await entered.promise
		const document = f.documents.get('project')!
		document.revision = 'two'
		document.files['a/main.typ'] = 'new layout'
		const second = f.service.compile({ ...target('b'), data: {} })
		await vi.waitFor(() => expect(f.materialize).toHaveBeenCalledTimes(2))
		expect(await readFile(join(oldRoot, 'a/main.typ'), 'utf8')).toBe('layout')
		f.setBeforeOpen(undefined)
		gate.resolve()
		expect(await first).toMatchObject({ code: 'REVISION_CONFLICT' })
		await second
		await expect(readFile(join(oldRoot, 'a/main.typ'))).rejects.toMatchObject({ code: 'ENOENT' })
	} finally {
		gate.resolve()
		await f.close()
	}
})

it('isolates temporary font registrations across projects and rebuilds changed font sessions', async () => {
	const f = await fixture()
	const gate = deferred()
	const entered = deferred()
	const seen: string[][] = []
	try {
		for (const [id, label] of [
			['project', 'font-a'],
			['other', 'font-b'],
		]) {
			const doc = f.documents.get(id!)!
			doc.config.fonts = ['fonts']
			doc.assets = [{ path: 'fonts/font.ttf', size: label!.length }]
			doc.files['fonts/font.ttf'] = label!
		}
		f.setBeforeOpen(async (_root, fonts) => {
			seen.push(fonts)
			if (seen.length === 1) {
				entered.resolve()
				await gate.promise
			}
		})
		const first = f.service.compile({ ...target(), data: {} })
		await entered.promise
		const second = f.service.compile({ ...target('a', 'other'), data: {} })
		await vi.waitFor(() => expect(f.materialize).toHaveBeenCalledTimes(2))
		expect([...f.registered.keys()]).toEqual(['font-a'])
		gate.resolve()
		const [old] = await Promise.all([first, second])
		expect(seen).toEqual([['font-a'], ['font-b']])
		expect(f.registered.size).toBe(0)
		const doc = f.documents.get('project')!
		doc.revision = 'font-change'
		doc.files['fonts/font.ttf'] = 'font-c'
		const next = await f.service.compile({ ...target(), data: {} })
		expect(f.sessions[0]!.closed).toBe(true)
		const rebuilt = await f.service.getPreview(next)
		expect(rebuilt.preview.revision).toBe(1)
		await expect(f.service.getPreview(old!)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
		expect(f.registered.size).toBe(0)
	} finally {
		gate.resolve()
		await f.close()
	}
})

it('deletes unpublished PDF files when source changes during the disk write', async () => {
	const f = await fixture()
	try {
		const compiled = await f.service.compile({ ...target(), data: {} })
		const publish = f.artifacts.publish.bind(f.artifacts)
		vi.spyOn(f.artifacts, 'publish').mockImplementation(
			(metadata, bytes, validate?: () => Promise<void>) =>
				publish(metadata, bytes, async () => {
					f.documents.get('project')!.revision = 'during-write'
					await validate?.()
				}),
		)
		await expect(f.service.exportPdf(compiled)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
		expect(await readdir(f.artifactRoot)).toEqual([])
	} finally {
		await f.close()
	}
})

it('drains only the removed project and keeps admission withdrawn through the workspace commit', async () => {
	const f = await fixture()
	const gate = deferred()
	const entered = deferred()
	const forgetGate = deferred()
	const forgetEntered = deferred()
	try {
		f.setBeforeUpdate(async (session) => {
			if (session.id === '1') {
				entered.resolve()
				await gate.promise
			}
		})
		const compiling = f.service.compile({ ...target(), data: {} })
		await entered.promise
		const removing = f.service.remove('project', async () => {
			forgetEntered.resolve()
			await forgetGate.promise
		})
		await expect(f.service.describeDocument(target())).rejects.toMatchObject({ code: 'CLOSED' })
		const independent = await f.service.compile({ ...target('a', 'other'), data: {} })
		expect(independent.projectId).toBe('other')
		gate.resolve()
		await compiling
		await forgetEntered.promise
		expect(f.sessions[0]!.closed).toBe(true)
		await expect(f.service.compile({ ...target(), data: {} })).rejects.toMatchObject({
			code: 'CLOSED',
		})
		forgetGate.resolve()
		await removing
	} finally {
		gate.resolve()
		forgetGate.resolve()
		await f.close()
	}
})

it('closes once, cancels accepted queues and waits for native work to settle before releasing resources', async () => {
	const f = await fixture()
	const entered = deferred()
	try {
		f.setBeforeUpdate(async (_session, input) => {
			entered.resolve()
			await new Promise<void>((_resolve, reject) =>
				input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true }),
			)
		})
		const compiling = f.service.compile({ ...target(), data: {} }).catch((error) => error)
		await entered.promise
		const queued = f.service.describeDocument(target()).catch((error) => error)
		const closing = f.service.close()
		expect(f.service.close()).toBe(closing)
		expect(await queued).toMatchObject({ code: 'CLOSED' })
		expect(await compiling).toMatchObject({ code: 'CLOSED' })
		await closing
		expect(f.sessions[0]!.closed).toBe(true)
		expect(f.describe).not.toHaveBeenCalled()
		await expect(f.service.compile({ ...target(), data: {} })).rejects.toMatchObject({
			code: 'CLOSED',
		})
	} finally {
		await f.close()
	}
})

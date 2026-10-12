import { reportEntry } from './storage-validation.js'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BasePlugin, Plugin } from '@pluxel/core'
import { FontsPlugin, type FontRegistration } from '@pluxel/fonts'
import { TypstPlugin, type TypstSession, type TypstNavigation } from '@pluxel/typst'
import { createHash } from 'node:crypto'
import { ElysiaApp } from '@pluxel/services/elysia'
import * as v from 'valibot'
import type {
	CompileResult,
	FileWrite,
	StudioError,
	WorkspaceSnapshot,
} from '../shared/contracts.js'
import { WorkspaceStore } from './store.js'
import { TemplateCompiler } from './compiler.js'
import { StudioAI } from './ai.js'
import type { PreviewPage, PreviewPagesRequest } from './ai-tools.js'
import { InputStore, inputData, inputRevision } from './inputs.js'

export const StudioConfig = v.object({ root: v.string(), assetsRoot: v.string() })

@Plugin({ displayName: 'Report Template Studio' })
export class StudioPlugin extends BasePlugin {
	private readonly config = this.configs.use(StudioConfig)
	private store!: WorkspaceStore
	private ai!: StudioAI
	private inputs!: InputStore
	private readonly compiler = new TemplateCompiler()
	private readonly sessions = new Map<
		string,
		{
			fonts: string
			revision: string
			template: string
			session: TypstSession
			rendered?: {
				revision: string
				nativeRevision: number
				sourceRevision: string
				storedInput: string
				navigation: TypstNavigation
			}
		}
	>()
	private readonly snapshots = new Map<
		string,
		{ root: string; doc: WorkspaceSnapshot; fonts: string; fontPaths: string[] }
	>()
	private queue: Promise<unknown> = Promise.resolve()
	private closed = false
	private readonly pdfs = new Map<string, { revision: string; bytes: Uint8Array }>()

	constructor(
		private readonly fonts: FontsPlugin,
		private readonly typst: TypstPlugin,
	) {
		super()
	}

	protected override async init() {
		this.store = new WorkspaceStore(
			join(this.config.root, 'workspaces'),
			this.config.assetsRoot,
			{},
			(id, entries) => this.inputs.copyEntries(id, entries),
		)
		this.inputs = new InputStore(join(this.config.root, 'inputs'))
		this.ai = new StudioAI({
			root: join(this.config.root, 'ai'),
			getProject: (id) => this.store.get(id),
			tree: (id) => this.store.tree(id),
			mkdir: (id, path) => this.store.mkdir(id, path),
			rename: (id, input) => this.store.rename(id, input),
			remove: (id, input) => this.store.remove(id, input),
			readFile: (id, path) => this.store.readFile(id, path),
			writeFile: (id, write) => this.store.writeFile(id, write),
			compile: (id, entry) => this.compile(id, entry),
			readPreviewPages: (id, input, signal) => this.readPreviewPages(id, input, signal),
		})
		this.ctx.effects.defer(async () => {
			this.closed = true
			await this.ai.dispose()
			await this.queue
			const cleanup = await Promise.allSettled([
				this.compiler.close(),
				...[...this.sessions.values()].map((value) => value.session.dispose()),
				...[...this.snapshots.values()].map((value) =>
					rm(value.root, { recursive: true, force: true }),
				),
			])
			this.sessions.clear()
			this.snapshots.clear()
			this.pdfs.clear()
			const failures = cleanup.filter((result) => result.status === 'rejected')
			if (failures.length > 0)
				throw new AggregateError(
					failures.map((result) => result.reason),
					'Studio compilation cleanup failed',
				)
		})
		await this.store.initialize()
		this.ctx
			.require(ElysiaApp)
			.error(({ error, set }) => {
				const value = error as Error & Omit<StudioError, 'error'>
				set.status = value.code === 'REVISION_CONFLICT' ? 409 : value.code === 'ENOENT' ? 404 : 400
				return {
					error: value.message,
					code: value.code,
					diagnostics: value.diagnostics,
					fields: value.fields,
					data: value.data,
				}
			})
			.get('/api/projects', () => this.store.list())
			.post('/api/projects', ({ body }) =>
				this.store.create(v.parse(v.object({ name: v.string() }), body)),
			)
			.post('/api/projects/open', ({ body }) =>
				this.store.open(v.parse(v.object({ root: v.string() }), body).root),
			)
			.post('/api/import', { parse: 'none' }, async ({ request, query }) =>
				this.store.import(new Uint8Array(await request.arrayBuffer()), query.name),
			)
			.get('/api/ai/models', () => this.ai.models())
			.get('/api/ai/providers', () => this.ai.providers())
			.put('/api/ai/providers/:id', ({ params, body }) =>
				this.ai.configureProvider(params.id, body),
			)
			.post('/api/ai/providers/:id/models', ({ params }) => this.ai.discoverModels(params.id))
			.get('/api/projects/:id', ({ params }) => this.store.get(params.id))
			.get('/api/projects/:id/tree', ({ params }) => this.store.tree(params.id))
			.get('/api/projects/:id/file', ({ params, query }) =>
				this.store.readFile(params.id, query.path ?? ''),
			)
			.put('/api/projects/:id/file', ({ params, body }) =>
				this.store.writeFile(params.id, body as FileWrite),
			)
			.post('/api/projects/:id/directory', ({ params, body }) =>
				this.store.mkdir(params.id, v.parse(v.object({ path: v.string() }), body).path),
			)
			.post('/api/projects/:id/report', ({ params, body }) =>
				this.store.createReport(params.id, v.parse(v.object({ path: v.string() }), body).path),
			)
			.post('/api/projects/:id/rename', ({ params, body }) =>
				this.store.rename(
					params.id,
					v.parse(
						v.object({ path: v.string(), to: v.string(), expectedVersion: v.string() }),
						body,
					),
				),
			)
			.delete('/api/projects/:id/file', ({ params, body }) =>
				this.store.remove(
					params.id,
					v.parse(v.object({ path: v.string(), expectedVersion: v.string() }), body),
				),
			)
			.delete('/api/projects/:id', async ({ params }) => {
				await this.ai.abort(params.id)
				const task = this.queue.then(async () => {
					await this.compiler.remove(params.id)
					for (const [key, value] of this.sessions)
						if (JSON.parse(key)[0] === params.id) {
							this.sessions.delete(key)
							await value.session.dispose()
						}
					const snapshot = this.snapshots.get(params.id)
					this.snapshots.delete(params.id)
					if (snapshot) await rm(snapshot.root, { recursive: true, force: true })
					await this.store.forget(params.id)
					for (const key of this.pdfs.keys())
						if (JSON.parse(key)[0] === params.id) this.pdfs.delete(key)
					return { ok: true }
				})
				this.queue = task.catch(() => {})
				return task
			})
			.get('/api/projects/:id/input', async ({ params, query }) => {
				await this.store.get(params.id)
				return { data: await this.inputs.get(params.id, this.entry(query.entry)) }
			})
			.put('/api/projects/:id/input', async ({ params, query, body }) => {
				await this.store.get(params.id)
				const data = v.parse(v.object({ data: v.unknown() }), body).data
				return { data: await this.inputs.set(params.id, this.entry(query.entry), data) }
			})
			.post('/api/projects/:id/compile', ({ params, body, request }) => {
				const input = v.parse(v.object({ entry: v.string(), data: v.optional(v.unknown()) }), body)
				return this.compile(
					params.id,
					input.entry,
					request.signal,
					input.data === undefined ? undefined : inputData(input.data),
				)
			})
			.get('/api/projects/:id/pdf', async ({ params, query }) => {
				await this.store.get(params.id)
				const pdf = this.pdfs.get(JSON.stringify([params.id, query.entry]))
				if (!pdf || pdf.revision !== query.revision)
					return Response.json(
						{
							error: 'This preview revision is unavailable; compile again',
							code: 'REVISION_CONFLICT',
						},
						{ status: 409 },
					)
				return new Response(Uint8Array.from(pdf.bytes), {
					headers: { 'content-type': 'application/pdf' },
				})
			})
			.get(
				'/api/projects/:id/export',
				async ({ params }) =>
					new Response(Uint8Array.from(await this.store.export(params.id)), {
						headers: { 'content-type': 'application/zip' },
					}),
			)
			.post('/api/projects/:id/assets', { parse: 'none' }, async ({ params, query, request }) =>
				this.store.putAsset(
					params.id,
					query.path ?? '',
					new Uint8Array(await request.arrayBuffer()),
					query.expectedVersion,
				),
			)
			.get('/api/projects/:id/search', ({ params, query }) => {
				const input = v.parse(
					v.object({
						q: v.pipe(v.string(), v.maxLength(500)),
						mode: v.picklist(['path', 'content']),
						caseSensitive: v.optional(v.picklist(['true', 'false'])),
					}),
					query,
				)
				return this.store.search(params.id, {
					query: input.q,
					mode: input.mode,
					caseSensitive: input.caseSensitive === 'true',
				})
			})
			.get('/api/projects/:id/ai/threads', ({ params }) => this.ai.threads(params.id))
			.post('/api/projects/:id/ai/threads', ({ params }) => this.ai.createThread(params.id))
			.get('/api/projects/:id/ai/threads/:threadId', ({ params }) =>
				this.ai.snapshot(params.id, params.threadId),
			)
			.patch('/api/projects/:id/ai/threads/:threadId', ({ params, body }) => {
				const { title } = v.parse(
					v.object({ title: v.pipe(v.string(), v.minLength(1), v.maxLength(100)) }),
					body,
				)
				return this.ai.renameThread(params.id, params.threadId, title)
			})
			.delete('/api/projects/:id/ai/threads/:threadId', async ({ params }) => {
				await this.ai.deleteThread(params.id, params.threadId)
				return { ok: true }
			})
			.post('/api/projects/:id/ai/threads/:threadId', async ({ params, body }) => {
				const input = v.parse(
					v.object({
						message: v.pipe(v.string(), v.maxLength(100_000)),
						provider: v.string(),
						model: v.string(),
						references: v.optional(v.array(v.string())),
					}),
					body,
				)
				await this.ai.prompt(params.id, params.threadId, input)
				return this.ai.snapshot(params.id, params.threadId)
			})
			.post('/api/projects/:id/ai/threads/:threadId/abort', async ({ params }) => {
				await this.ai.abort(params.id, params.threadId)
				return this.ai.snapshot(params.id, params.threadId)
			})
	}

	private entry(value: unknown): string {
		if (
			typeof value !== 'string' ||
			!reportEntry(value) ||
			value.startsWith('/') ||
			value.split('/').some((part) => !part || part === '.' || part === '..') ||
			value.includes('\\')
		)
			throw new Error('Invalid document entry')
		return value
	}

	private async materialized(id: string) {
		const current = await this.store.snapshot(id)
		const previous = this.snapshots.get(id)
		if (previous?.doc.revision === current.revision) return previous
		const root = await mkdtemp(join(tmpdir(), 'pluxel-studio-'))
		try {
			const doc = await this.store.materialize(id, root)
			const fontPaths = doc.assets
				.filter(
					(item) =>
						/\.(ttf|otf)$/i.test(item.path) &&
						doc.config.fonts.some(
							(font) => item.path === font || item.path.startsWith(font.replace(/\/$/, '') + '/'),
						),
				)
				.map((item) => item.path)
			const hash = createHash('sha256')
			for (const path of fontPaths) hash.update(path).update(await readFile(join(root, path)))
			const value = { root, doc, fontPaths, fonts: hash.digest('hex') }
			this.snapshots.delete(id)
			this.snapshots.set(id, value)
			if (previous) await rm(previous.root, { recursive: true, force: true })
			while (this.snapshots.size > 4) {
				const [key, old] = this.snapshots.entries().next().value!
				this.snapshots.delete(key)
				await rm(old.root, { recursive: true, force: true })
			}
			return value
		} catch (error) {
			await rm(root, { recursive: true, force: true })
			throw error
		}
	}

	/** Serial compilation owns temporary font registrations until the official session closes. */
	private compile(
		id: string,
		entry: string,
		signal?: AbortSignal,
		suppliedData?: Record<string, unknown>,
	): Promise<CompileResult> {
		if (this.closed) return Promise.reject(new Error('Studio is closed'))
		const task = this.queue.then(async () => {
			if (this.closed) throw new Error('Studio is closed')
			signal?.throwIfAborted()
			const started = performance.now()
			const { root, doc, fonts, fontPaths } = await this.materialized(id)
			const registrations: FontRegistration[] = []
			try {
				const storedInput = await this.inputs.get(id, entry)
				const evaluated = await this.compiler.evaluate(doc, entry, suppliedData ?? storedInput)
				signal?.throwIfAborted()
				const key = JSON.stringify([id, entry])
				let retained = this.sessions.get(key)
				if (retained && retained.fonts !== fonts) {
					this.sessions.delete(key)
					await retained.session.dispose()
					retained = undefined
				}
				if (!retained) {
					if (this.sessions.size >= 4) {
						const [oldKey, old] = this.sessions.entries().next().value!
						this.sessions.delete(oldKey)
						await old.session.dispose()
					}
					for (const path of fontPaths)
						registrations.push(
							await this.fonts.registerFromPath({ path: join(root, path), signal }),
						)
					retained = {
						fonts,
						revision: doc.revision,
						template: evaluated.template,
						session: await this.typst.open({ root, entry: evaluated.template }, { signal }),
					}
					this.sessions.set(key, retained)
				}
				const session = retained.session
				let compiled
				try {
					compiled = await session.update({
						...(retained.revision === doc.revision && retained.template === evaluated.template
							? {}
							: { template: { root, entry: evaluated.template } }),
						files: evaluated.files,
						signal,
						timeoutMs: 30_000,
					})
				} catch (error) {
					if (error instanceof Error && 'code' in error && error.code === 'COMPILE_FAILED') {
						// Native compilation already consumed the replacement, even without an output revision.
						retained.revision = doc.revision
						retained.template = evaluated.template
					} else {
						this.sessions.delete(key)
						await session.dispose()
					}
					throw error
				}
				retained.revision = doc.revision
				retained.template = evaluated.template
				const bytes = await session.exportPdf(compiled.revision)
				signal?.throwIfAborted()
				this.pdfs.delete(key)
				const revision = inputRevision(doc.revision, entry, evaluated.data)
				retained.rendered = {
					revision,
					nativeRevision: compiled.revision,
					sourceRevision: doc.revision,
					storedInput: JSON.stringify(storedInput),
					navigation: compiled.preview.navigation,
				}
				this.pdfs.set(key, { revision, bytes })
				while (
					this.pdfs.size > 8 ||
					[...this.pdfs.values()].reduce((sum, pdf) => sum + pdf.bytes.byteLength, 0) >
						64 * 1024 * 1024
				)
					this.pdfs.delete(this.pdfs.keys().next().value!)
				return {
					projectId: id,
					entry,
					name: evaluated.name,
					template: evaluated.template,
					data: evaluated.data,
					revision,
					fields: evaluated.fields,
					sourceVersions: Object.fromEntries(
						Object.entries(doc.files).map(([path, source]) => [
							path,
							createHash('sha256').update(source).digest('hex'),
						]),
					),
					preview: { ...compiled.preview, data: Array.from(compiled.preview.data) },
					diagnostics: [...compiled.diagnostics],
					elapsedMs: performance.now() - started,
				}
			} finally {
				for (const registration of registrations.toReversed()) registration.dispose()
			}
		})
		this.queue = task.catch(() => {})
		return task
	}

	/** Agent images borrow the exact successful compilation; reading never compiles. */
	readPreviewPages(
		id: string,
		input: PreviewPagesRequest,
		signal?: AbortSignal,
	): Promise<readonly PreviewPage[]> {
		if (this.closed) return Promise.reject(new Error('Studio is closed'))
		const task = this.queue.then(async () => {
			if (this.closed) throw new Error('Studio is closed')
			signal?.throwIfAborted()
			const request = v.parse(
				v.object({
					entry: v.string(),
					revision: v.string(),
					pages: v.pipe(
						v.array(v.pipe(v.number(), v.integer(), v.minValue(1))),
						v.minLength(1),
						v.maxLength(3),
					),
					maxDimensionPx: v.optional(
						v.pipe(v.number(), v.integer(), v.minValue(256), v.maxValue(2048)),
						1600,
					),
					region: v.optional(
						v.object({
							x: v.pipe(v.number(), v.finite(), v.minValue(0)),
							y: v.pipe(v.number(), v.finite(), v.minValue(0)),
							width: v.pipe(v.number(), v.finite(), v.minValue(Number.MIN_VALUE)),
							height: v.pipe(v.number(), v.finite(), v.minValue(Number.MIN_VALUE)),
						}),
					),
				}),
				input,
			)
			const entry = this.entry(request.entry)
			if (new Set(request.pages).size !== request.pages.length)
				throw new Error('Preview pages must be distinct')
			const retained = this.sessions.get(JSON.stringify([id, entry]))
			const rendered = retained?.rendered
			const stale = () =>
				Object.assign(
					new Error('预览版本已过期。请先重新调用 compile_preview，再读取该版本的页面。'),
					{ code: 'REVISION_CONFLICT' },
				)
			if (!retained || !rendered || rendered.revision !== request.revision) throw stale()
			const current = await this.store.snapshot(id)
			if (
				current.revision !== rendered.sourceRevision ||
				JSON.stringify(await this.inputs.get(id, entry)) !== rendered.storedInput
			)
				throw stale()
			const images: PreviewPage[] = []
			let bytes = 0
			for (const pageNumber of request.pages) {
				signal?.throwIfAborted()
				const page = rendered.navigation.pages.find((item) => item.page === pageNumber)
				if (!page)
					throw new Error(
						`Page ${pageNumber} is outside this ${rendered.navigation.pages.length}-page preview`,
					)
				const region = request.region ?? { x: 0, y: 0, width: page.width, height: page.height }
				// Bound full-page raster allocation as well as the requested crop. A long
				// page may need a lower scale; the returned pixel size makes that visible.
				const scale = Math.min(
					4,
					request.maxDimensionPx / Math.max(region.width, region.height),
					8191 / Math.max(page.width, page.height),
					Math.sqrt(15_999_000 / (page.width * page.height)),
				)
				let image
				try {
					image = await retained.session.renderPage({
						revision: rendered.nativeRevision,
						page: pageNumber,
						scale,
						region,
						signal,
						timeoutMs: 15_000,
					})
				} catch (error) {
					if (signal?.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
						this.sessions.delete(JSON.stringify([id, entry]))
						await retained.session.dispose()
					}
					throw error
				}
				bytes += image.data.byteLength
				if (bytes > 12 * 1024 * 1024)
					throw new Error(
						'Preview images exceed 12 MiB; request fewer pages or a smaller maxDimensionPx',
					)
				const sources = new Map<string, { path: string; fromLine: number; toLine: number }>()
				for (const point of rendered.navigation.points) {
					if (
						point.page !== pageNumber ||
						point.x + point.width < image.region.x ||
						point.y + point.height < image.region.y ||
						point.x > image.region.x + image.region.width ||
						point.y > image.region.y + image.region.height
					)
						continue
					const range = sources.get(point.path)
					if (range) {
						range.fromLine = Math.min(range.fromLine, point.line)
						range.toLine = Math.max(range.toLine, point.endLine)
					} else if (sources.size < 24)
						sources.set(point.path, {
							path: point.path,
							fromLine: point.line,
							toLine: point.endLine,
						})
				}
				images.push({
					...image,
					headings: rendered.navigation.outline.filter((item) => item.page === pageNumber),
					sources: [...sources.values()],
				})
			}
			signal?.throwIfAborted()
			// External file/input edits do not go through this queue. Reject a read
			// whose source changed during rasterization rather than returning stale images.
			const currentSource = await this.store.snapshot(id)
			if (
				currentSource.revision !== rendered.sourceRevision ||
				JSON.stringify(await this.inputs.get(id, entry)) !== rendered.storedInput
			)
				throw stale()
			return images
		})
		this.queue = task.catch(() => {})
		return task
	}
}

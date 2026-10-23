import { join, isAbsolute } from 'node:path'
import { open } from 'node:fs/promises'
import { BasePlugin, Plugin } from '@pluxel/core'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { TypstPlugin } from '@pluxel/plugin-typst'
import * as v from 'valibot'
import type {
	DesktopApi,
	DocumentTarget,
	CompileRequest,
	RenderPageRequest,
	RevisionTarget,
	FileWrite,
	AiPrompt,
	WorkspaceArtifact,
	InputWrite,
} from '../shared/contracts.js'
import type { SearchOptions } from '../shared/search.js'
import type { AiProviderWrite } from '../shared/ai-providers.js'
import { WorkspaceStore } from './store.js'
import { InputStore, inputData, editorDraft } from './inputs.js'
import { DocumentService } from './documents.js'
import { ArtifactStore } from './artifacts.js'
import { StudioAI } from './ai.js'
import { MAX_FILE, MAX_ARCHIVE, safePath, pathName, reportEntry } from './storage-validation.js'

export const StudioConfig = v.object({ root: v.string(), assetsRoot: v.string() })
const string = v.pipe(v.string(), v.minLength(1), v.maxLength(1024))
const project = v.object({ projectId: string })
const document = v.object({ projectId: string, entry: string })
const thread = v.object({ projectId: string, threadId: string })
function parse<T extends v.GenericSchema>(schema: T, input: unknown): v.InferOutput<T> {
	const result = v.safeParse(schema, input)
	if (result.success) return result.output
	throw Object.assign(new Error('Invalid Studio input'), {
		code: 'INVALID_INPUT',
		issues: result.issues.map((issue) => ({
			path: issue.path?.map((part) => part.key) ?? [],
			rule: issue.type,
			message: issue.message,
		})),
	})
}

/** Composition owner. RPC capabilities expose named subsets, never this Plugin object. */
@Plugin({ displayName: 'Report Template Studio' })
export class StudioPlugin extends BasePlugin implements DesktopApi {
	private readonly config = this.configs.use(StudioConfig)
	private store!: WorkspaceStore
	private ai!: StudioAI
	private inputs!: InputStore
	private documents!: DocumentService
	private artifacts!: ArtifactStore
	private closed = false
	constructor(
		private readonly fonts: FontsPlugin,
		private readonly typst: TypstPlugin,
	) {
		super()
	}
	protected override async init() {
		this.inputs = new InputStore(join(this.config.root, 'inputs'))
		this.store = new WorkspaceStore(
			join(this.config.root, 'workspaces'),
			this.config.assetsRoot,
			{},
			(id, entries, revisions) => this.inputs.copyEntries(id, entries, revisions),
			(id, entries) => this.inputs.removeEntries(id, entries),
		)
		this.artifacts = new ArtifactStore(join(this.config.root, 'artifacts'))
		this.documents = new DocumentService(this.store, this.fonts, this.typst, this.artifacts)
		this.ai = new StudioAI({
			root: join(this.config.root, 'ai'),
			getProject: (id) => this.getProject({ projectId: id }),
			tree: (id) => this.getTree({ projectId: id }),
			mkdir: (id, path) => this.mkdir({ projectId: id, path }),
			rename: (id, input) => this.rename({ projectId: id, ...input }),
			remove: (id, input) => this.remove({ projectId: id, ...input }),
			readFile: (id, path) => this.readFile({ projectId: id, path }),
			writeFile: (id, write) => this.writeFile({ projectId: id, ...write }),
			compile: (input) => this.compile(input),
			getInput: (input) => this.getInput(input),
			getPreview: (input) => this.getPreview(input),
			renderPage: (input) => this.renderPage(input),
			exportPdf: (input) => this.exportPdf(input),
			readArtifact: (id) => this.artifacts.read(id),
		})
		this.ctx.effects.defer(async () => {
			this.closed = true
			try {
				await this.ai.dispose()
			} finally {
				try {
					await this.documents.close()
				} finally {
					await this.artifacts.close()
				}
			}
		})
		await this.store.initialize()
		await this.artifacts.initialize()
	}
	private ready() {
		if (this.closed)
			throw Object.assign(new Error('Studio backend generation is closed'), { code: 'CLOSED' })
	}
	private project(input: unknown) {
		this.ready()
		return parse(project, input)
	}
	private document(input: unknown) {
		this.ready()
		const target = parse(document, input)
		if (!reportEntry(target.entry))
			throw Object.assign(new Error('entry must refer to folder/folder.ts'), {
				code: 'INVALID_INPUT',
			})
		pathName(target.entry)
		return target
	}
	listProjects() {
		this.ready()
		return this.store.list()
	}
	getProject(input: { projectId: string }) {
		const { projectId } = this.project(input)
		return this.store.get(projectId)
	}
	createProject(input: { name: string }) {
		this.ready()
		return this.store.create(
			parse(v.object({ name: v.pipe(v.string(), v.minLength(1), v.maxLength(160)) }), input),
		)
	}
	openProject(input: { root: string }) {
		this.ready()
		return this.store.open(parse(v.object({ root: string }), input).root)
	}
	async forgetProject(input: { projectId: string }) {
		const { projectId } = this.project(input)
		await this.ai.abort(projectId)
		await this.documents.remove(projectId, () => this.store.forget(projectId))
		return { ok: true as const }
	}
	getTree(input: { projectId: string }) {
		const { projectId } = this.project(input)
		return this.store.tree(projectId)
	}
	readFile(input: { projectId: string; path: string }) {
		this.ready()
		const data = parse(v.object({ projectId: string, path: string }), input)
		return this.store.readFile(data.projectId, data.path)
	}
	writeFile(input: FileWrite & { projectId: string }) {
		this.ready()
		const data = parse(
			v.object({
				projectId: string,
				path: string,
				content: v.string(),
				expectedVersion: v.nullable(string),
			}),
			input,
		)
		return this.store.writeFile(data.projectId, data)
	}
	mkdir(input: { projectId: string; path: string }) {
		this.ready()
		const data = parse(v.object({ projectId: string, path: string }), input)
		return this.store.mkdir(data.projectId, data.path)
	}
	createReport(input: { projectId: string; path: string }) {
		this.ready()
		const data = parse(v.object({ projectId: string, path: string }), input)
		return this.store.createReport(data.projectId, data.path)
	}
	rename(input: { projectId: string; path: string; to: string; expectedVersion: string }) {
		this.ready()
		const data = parse(
			v.object({ projectId: string, path: string, to: string, expectedVersion: string }),
			input,
		)
		return this.store.rename(data.projectId, data)
	}
	remove(input: { projectId: string; path: string; expectedVersion: string }) {
		this.ready()
		const data = parse(
			v.object({ projectId: string, path: string, expectedVersion: string }),
			input,
		)
		return this.store.remove(data.projectId, data)
	}
	search(input: SearchOptions & { projectId: string }) {
		this.ready()
		const data = parse(
			v.object({
				projectId: string,
				query: v.pipe(v.string(), v.maxLength(500)),
				mode: v.picklist(['path', 'content']),
				caseSensitive: v.optional(v.boolean()),
			}),
			input,
		)
		return this.store.search(data.projectId, data)
	}
	async getInput(input: DocumentTarget) {
		const target = this.document(input)
		await this.store.get(target.projectId)
		return this.inputs.get(target.projectId, target.entry)
	}
	async setInput(input: InputWrite) {
		const target = this.document(input)
		const data = inputData(input.data)
		const editor = input.editor === undefined ? undefined : editorDraft(input.editor)
		const { expectedVersion } = parse(v.object({ expectedVersion: v.nullable(string) }), input)
		await this.documents.validateInput({ ...target, data, ...(editor ? { editor } : {}) })
		return this.inputs.set(target.projectId, target.entry, {
			data,
			...(editor ? { editor } : {}),
			expectedVersion,
		})
	}
	describeDocument(input: DocumentTarget) {
		this.ready()
		return this.documents.describeDocument(input)
	}
	compile(input: CompileRequest) {
		this.ready()
		return this.documents.compile(input)
	}
	getPreview(input: RevisionTarget) {
		this.ready()
		return this.documents.getPreview(input)
	}
	renderPage(input: RenderPageRequest) {
		this.ready()
		return this.documents.renderPage(input)
	}
	exportPdf(input: RevisionTarget) {
		this.ready()
		return this.documents.exportPdf(input)
	}
	private bytes(input: Uint8Array, limit: number) {
		if (!(input instanceof Uint8Array))
			throw Object.assign(new Error('Expected binary input'), { code: 'INVALID_INPUT' })
		if (input.byteLength > limit)
			throw Object.assign(new Error('Import exceeds file limit'), { code: 'LIMIT_EXCEEDED' })
		return input
	}
	importWorkspace(input: { bytes: Uint8Array; name?: string }) {
		this.ready()
		const data = parse(v.object({ bytes: v.unknown(), name: v.optional(string) }), input)
		return this.store.import(this.bytes(data.bytes as Uint8Array, MAX_ARCHIVE), data.name)
	}
	putAsset(input: {
		projectId: string
		path: string
		bytes: Uint8Array
		expectedVersion?: string
	}) {
		this.ready()
		const data = parse(
			v.object({
				projectId: string,
				path: string,
				bytes: v.unknown(),
				expectedVersion: v.optional(string),
			}),
			input,
		)
		return this.store.putAsset(
			data.projectId,
			data.path,
			this.bytes(data.bytes as Uint8Array, MAX_FILE),
			data.expectedVersion,
		)
	}
	exportWorkspace(input: { projectId: string }) {
		const { projectId } = this.project(input)
		return this.store.export(projectId)
	}
	private async importFile(path: string, limit: number) {
		if (!isAbsolute(path))
			throw Object.assign(new Error('Import source must be an absolute local path'), {
				code: 'INVALID_INPUT',
			})
		const file = await open(await safePath(path), 'r')
		try {
			const info = await file.stat()
			if (!info.isFile())
				throw Object.assign(new Error('Import source must be a regular file'), {
					code: 'INVALID_INPUT',
				})
			if (info.size > limit)
				throw Object.assign(new Error('Import source exceeds file limit'), {
					code: 'LIMIT_EXCEEDED',
				})
			const bytes = Buffer.alloc(info.size + 1)
			let offset = 0
			while (offset < bytes.length) {
				const read = await file.read(bytes, offset, bytes.length - offset, null)
				if (!read.bytesRead) break
				offset += read.bytesRead
			}
			if (offset !== info.size)
				throw Object.assign(new Error('Import source changed during read'), {
					code: 'REVISION_CONFLICT',
				})
			return bytes.subarray(0, offset)
		} finally {
			await file.close()
		}
	}
	async importWorkspaceFile(input: { path: string; name?: string }) {
		this.ready()
		const data = parse(v.object({ path: string, name: v.optional(string) }), input)
		if (!data.path.toLowerCase().endsWith('.zip'))
			throw Object.assign(new Error('Workspace import requires a ZIP file'), {
				code: 'INVALID_INPUT',
			})
		return this.store.import(await this.importFile(data.path, MAX_ARCHIVE), data.name)
	}
	async importAssetFile(input: {
		projectId: string
		path: string
		sourcePath: string
		expectedVersion?: string
	}) {
		this.ready()
		const data = parse(
			v.object({
				projectId: string,
				path: string,
				sourcePath: string,
				expectedVersion: v.optional(string),
			}),
			input,
		)
		await this.store.get(data.projectId)
		return this.store.putAsset(
			data.projectId,
			data.path,
			await this.importFile(data.sourcePath, MAX_FILE),
			data.expectedVersion,
		)
	}
	async exportWorkspaceFile(input: { projectId: string }) {
		const { projectId } = this.project(input)
		const before = await this.store.tree(projectId)
		const bytes = await this.store.export(projectId)
		return this.artifacts.publish<WorkspaceArtifact>(
			{ projectId, entry: '', revision: before.revision, kind: 'zip', mimeType: 'application/zip' },
			bytes,
			async () => {
				const current = await this.store.tree(projectId)
				if (current.revision !== before.revision)
					throw Object.assign(new Error('Workspace changed during ZIP export'), {
						code: 'REVISION_CONFLICT',
					})
			},
		)
	}
	/** Trusted shell adapter only; never exposed to renderer or external agent targets. */
	resolveArtifact(input: { id: string }) {
		this.ready()
		return this.artifacts.resolve(parse(v.object({ id: string }), input).id)
	}
	models() {
		this.ready()
		return this.ai.models()
	}
	providers() {
		this.ready()
		return this.ai.providers()
	}
	configureProvider(input: { id: string; config: AiProviderWrite }) {
		this.ready()
		const data = parse(v.object({ id: string, config: v.unknown() }), input)
		return this.ai.configureProvider(data.id, data.config)
	}
	discoverModels(input: { id: string }) {
		this.ready()
		return this.ai.discoverModels(parse(v.object({ id: string }), input).id)
	}
	threads(input: { projectId: string }) {
		const { projectId } = this.project(input)
		return this.ai.threads(projectId)
	}
	createThread(input: { projectId: string }) {
		const { projectId } = this.project(input)
		return this.ai.createThread(projectId)
	}
	snapshot(input: { projectId: string; threadId: string }) {
		this.ready()
		const data = parse(thread, input)
		return this.ai.snapshot(data.projectId, data.threadId)
	}
	renameThread(input: { projectId: string; threadId: string; title: string }) {
		this.ready()
		const data = parse(
			v.object({
				projectId: string,
				threadId: string,
				title: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
			}),
			input,
		)
		return this.ai.renameThread(data.projectId, data.threadId, data.title)
	}
	async deleteThread(input: { projectId: string; threadId: string }) {
		this.ready()
		const data = parse(thread, input)
		await this.ai.deleteThread(data.projectId, data.threadId)
		return { ok: true as const }
	}
	async prompt(input: AiPrompt & { projectId: string; threadId: string }) {
		this.ready()
		const data = parse(
			v.object({
				projectId: string,
				threadId: string,
				message: v.pipe(v.string(), v.maxLength(100_000)),
				provider: string,
				model: string,
				references: v.optional(v.array(string)),
			}),
			input,
		)
		await this.ai.prompt(data.projectId, data.threadId, data)
		return this.ai.snapshot(data.projectId, data.threadId)
	}
	async abort(input: { projectId: string; threadId: string }) {
		this.ready()
		const data = parse(thread, input)
		await this.ai.abort(data.projectId, data.threadId)
		return this.ai.snapshot(data.projectId, data.threadId)
	}
}

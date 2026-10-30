import type { FieldNode } from 'valibot-form'
import type { RpcStub, RpcTarget } from 'capnweb'
import type { TypstPreview } from '@pluxel/plugin-typst/browser'
import type { TypstSourceComponent, TypstSourcePatch } from '@pluxel/plugin-typst/source'
import type {
	TypstDiagnostic,
	TypstPage,
	TypstOutlineItem,
	TypstRegion,
} from '@pluxel/plugin-typst'
import type { SearchOptions, SearchResult } from './search.js'
import type { AiProviders, AiProviderWrite, AiProvider } from './ai-providers.js'

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject {
	[key: string]: JsonValue
}
export interface DocumentTarget {
	projectId: string
	entry: string
}
export interface CompileRequest extends DocumentTarget {
	data: JsonObject
	/** Host-owned version of this captured source and data snapshot, including unsaved edits. */
	clientRevision: number
	editor?: EditorDraft
}
export interface EditorDraft {
	/** Complete ordinary text-file snapshot. No Tiptap document is persisted. */
	files: Record<string, string>
}
export interface DocumentInput {
	/** Read-only image bytes from this storageVersion, for source views. Binary writes remain workspace asset IO. */
	assets?: WorkspaceSnapshot['assets']
	/** Raw JSON from the report's adjacent data.json; schema output remains derived. */
	data: JsonObject
	editor?: EditorDraft
	/** Workspace source revision used for an atomic source/data save. */
	storageVersion: string | null
}
export interface InputWrite extends DocumentTarget {
	data: JsonObject
	editor?: EditorDraft
	expectedVersion: string | null
}
export interface BodyRead extends DocumentTarget {
	path?: string
	/** UTF-8 byte range in the requested source file. */
	range?: { from: number; to: number }
}
export interface BodySnapshot extends DocumentTarget {
	baseRevision: string
	sourceRevision: string
	files: { path: string; label: string; source: string; range?: { from: number; to: number } }[]
}
export interface BodyCandidate extends DocumentTarget {
	path: string
	baseRevision: string
	source: string
	range?: { from: number; to: number }
}
export interface BodyCommit extends DocumentTarget {
	input: DocumentInput
	baseRevision: string
	editorStatus: 'applied' | 'headless' | 'disconnected'
	compile?: CompileResult
	previewError?: string
	editorError?: string
}
/** A captured desktop snapshot is leased; the backend commits its source transaction once. */
export interface BodyEditorParticipant extends RpcTarget {
	capture(input: { entry: string }): Promise<{
		lease: string
		input: DocumentInput
		clientRevision: number
	} | null>
	finish(input: {
		entry: string
		lease: string
		commit?: {
			input: DocumentInput
			patches: TypstSourcePatch[]
			data: JsonObject
			compile?: CompileResult
			preview?: PreviewResult
			previewError?: string
		}
	}): Promise<void>
}
export interface BodyEditorAttachment extends RpcTarget {
	close(): Promise<void>
}
export interface EditorDescription {
	/** These ordinary files are the editable body. Templates may include them repeatedly. */
	sources: { path: string; label?: string }[]
	components?: readonly TypstSourceComponent[]
}
export interface RevisionTarget extends DocumentTarget {
	revision: string
}
export interface RenderPageRequest extends RevisionTarget {
	page: number
	scale?: number
	region?: TypstRegion
}
export interface DocumentDescription extends DocumentTarget {
	name: string
	template: string
	sourceRevision: string
	fields: FieldNode[]
	defaults: JsonObject
	editor?: EditorDescription
}
export interface PreviewResult extends RevisionTarget {
	clientRevision: number
	sourceRevision: string
	sourceVersions: Readonly<Record<string, string>>
	preview: TypstPreview
}
export interface Artifact extends RevisionTarget {
	id: string
	path: string
	byteLength: number
	createdAt: string
	expiresAt: string
}
export interface PdfArtifact extends Artifact {
	kind: 'pdf'
	mimeType: 'application/pdf'
}
export interface WorkspaceArtifact extends Artifact {
	kind: 'zip'
	mimeType: 'application/zip'
}
export interface PageArtifact extends Artifact {
	kind: 'png'
	mimeType: 'image/png'
	page: number
	width: number
	height: number
	region: TypstRegion
	headings: readonly TypstOutlineItem[]
	sources: readonly { path: string; fromLine: number; toLine: number }[]
}
export type ArtifactUnion = PdfArtifact | PageArtifact | WorkspaceArtifact

export interface ProjectSummary {
	id: string
	name: string
	root: string
}
export interface DocumentConfig {
	name: string
	entry: string
}
export interface WorkspaceConfig {
	name: string
	fonts: string[]
}
export interface FileEntry {
	path: string
	kind: 'file' | 'directory'
	size: number
	version: string
	binary?: boolean
}
export interface WorkspaceTree {
	documents: DocumentConfig[]
	configError?: string
	project: ProjectSummary
	revision: string
	entries: FileEntry[]
	config: WorkspaceConfig
}
export interface TextFile {
	path: string
	content: string
	version: string
}
export interface FileWrite {
	path: string
	content: string
	expectedVersion: string | null
}
export interface WorkspaceSnapshot {
	project: ProjectSummary
	revision: string
	config: WorkspaceConfig
	files: Record<string, string>
	assets: { path: string; size: number; bytes: Uint8Array }[]
}
export interface CompileResult extends DocumentTarget {
	name: string
	template: string
	revision: string
	sourceRevision: string
	data: JsonObject
	clientRevision: number
	pageCount: number
	pages: readonly TypstPage[]
	outline: readonly TypstOutlineItem[]
	diagnostics: readonly TypstDiagnostic[]
	elapsedMs: number
}
export interface StudioError {
	message: string
	code: string
	diagnostics?: CompileResult['diagnostics']
	issues?: readonly { path: readonly (string | number)[]; rule: string; message: string }[]
	projectId?: string
	entry?: string
	revision?: string
}
/** Errors remain rejects; inspect serializable fields instead of class identity. */
export function isStudioError(value: unknown): value is StudioError {
	return (
		!!value &&
		typeof value === 'object' &&
		'code' in value &&
		typeof value.code === 'string' &&
		'message' in value &&
		typeof value.message === 'string'
	)
}

export interface StudioApi {
	listProjects(): Promise<ProjectSummary[]>
	getProject(input: { projectId: string }): Promise<ProjectSummary>
	createProject(input: { name: string }): Promise<ProjectSummary>
	openProject(input: { root: string }): Promise<ProjectSummary>
	forgetProject(input: { projectId: string }): Promise<{ ok: true }>
	getTree(input: { projectId: string }): Promise<WorkspaceTree>
	readFile(input: { projectId: string; path: string }): Promise<TextFile>
	writeFile(input: FileWrite & { projectId: string }): Promise<TextFile>
	mkdir(input: { projectId: string; path: string }): Promise<WorkspaceTree>
	createReport(input: { projectId: string; path: string }): Promise<{ entry: string }>
	rename(input: {
		projectId: string
		path: string
		to: string
		expectedVersion: string
	}): Promise<WorkspaceTree>
	remove(input: {
		projectId: string
		path: string
		expectedVersion: string
	}): Promise<WorkspaceTree>
	search(input: SearchOptions & { projectId: string }): Promise<SearchResult>
	getInput(input: DocumentTarget): Promise<DocumentInput>
	setInput(input: InputWrite): Promise<DocumentInput>
	readBody(input: BodyRead): Promise<BodySnapshot>
	applyBodyCandidate(input: BodyCandidate): Promise<BodyCommit>
	describeDocument(input: DocumentTarget): Promise<DocumentDescription>
	compile(input: CompileRequest): Promise<CompileResult>
	renderPage(input: RenderPageRequest): Promise<PageArtifact>
	exportPdf(input: RevisionTarget): Promise<PdfArtifact>
	importWorkspaceFile(input: { path: string; name?: string }): Promise<ProjectSummary>
	importAssetFile(input: {
		projectId: string
		path: string
		sourcePath: string
		expectedVersion?: string
	}): Promise<WorkspaceTree>
	exportWorkspaceFile(input: { projectId: string }): Promise<WorkspaceArtifact>
}
export interface DesktopApi extends StudioApi {
	attachBodyEditor(
		input: { projectId: string },
		participant: RpcStub<BodyEditorParticipant>,
	): Promise<BodyEditorAttachment>
	getPreview(input: RevisionTarget): Promise<PreviewResult>
	importWorkspace(input: { bytes: Uint8Array; name?: string }): Promise<ProjectSummary>
	putAsset(input: {
		projectId: string
		path: string
		bytes: Uint8Array
		expectedVersion?: string
	}): Promise<WorkspaceTree>
	exportWorkspace(input: { projectId: string }): Promise<Uint8Array>
	models(): Promise<AiModel[]>
	providers(): Promise<AiProviders>
	configureProvider(input: { id: string; config: AiProviderWrite }): Promise<AiProvider>
	discoverModels(input: { id: string }): Promise<AiModel[]>
	threads(input: { projectId: string }): Promise<AiThread[]>
	createThread(input: { projectId: string }): Promise<AiSnapshot>
	snapshot(input: { projectId: string; threadId: string }): Promise<AiSnapshot>
	renameThread(input: { projectId: string; threadId: string; title: string }): Promise<AiThread>
	deleteThread(input: { projectId: string; threadId: string }): Promise<{ ok: true }>
	prompt(input: AiPrompt & { projectId: string; threadId: string }): Promise<AiSnapshot>
	abort(input: { projectId: string; threadId: string }): Promise<AiSnapshot>
}
export interface StudioBridge {
	connect(): void
	saveArtifact(input: { artifactId: string; suggestedName: string }): Promise<boolean>
	saveFile(input: { suggestedName: string; bytes: Uint8Array }): Promise<boolean>
	importFile(input: {
		kind: 'asset' | 'workspace'
	}): Promise<{ name: string; bytes: Uint8Array } | null>
	openProject(): Promise<ProjectSummary | null>
	revealInFileManager(input: { projectId: string; path: string }): Promise<void>
}
export interface AiModel {
	provider: string
	id: string
	name: string
	imageInput?: boolean
}
export type AiMessageStatus = 'running' | 'complete' | 'error' | 'cancelled'
export type AiMessagePart =
	| { type: 'text' | 'reasoning'; text: string }
	| {
			type: 'tool-call'
			toolCallId: string
			toolName: string
			args: Record<string, unknown>
			argsText: string
			result?: unknown
			isError?: boolean
			status: 'running' | 'complete' | 'error' | 'incomplete'
	  }
export interface AiMessage {
	id: string
	role: 'user' | 'assistant'
	content: AiMessagePart[]
	status?: AiMessageStatus
}
export interface AiThread {
	id: string
	title: string
	updatedAt: number
	provider?: string
	model?: string
	running: boolean
}
export interface AiSnapshot {
	threadId: string
	title: string
	provider?: string
	model?: string
	messages: AiMessage[]
	running: boolean
	error?: string
	activity?: string
}
export interface AiPrompt {
	message: string
	provider: string
	model: string
	references?: string[]
}
declare global {
	interface Window {
		studio: StudioBridge
	}
}

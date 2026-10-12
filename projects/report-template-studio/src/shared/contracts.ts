import type { FieldNode } from 'valibot-form'
import type { TypstPreview } from '@pluxel/typst/browser'

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
	assets: { path: string; size: number }[]
}
export interface CompileResult {
	name: string
	template: string
	projectId: string
	entry: string
	revision: string
	fields: FieldNode[]
	data: Record<string, unknown>
	/** Saved workspace content versions used by this exact compilation. */
	sourceVersions: Record<string, string>
	preview: Omit<TypstPreview, 'data'> & { data: number[] }
	diagnostics: {
		severity: string
		message: string
		path?: string
		range?: { start: { line: number; character: number }; end: { line: number; character: number } }
	}[]
	elapsedMs: number
}
export interface StudioError {
	error: string
	code?: string
	diagnostics?: CompileResult['diagnostics']
	fields?: FieldNode[]
	data?: Record<string, unknown>
}
export interface FetchRequest {
	path: string
	method: string
	headers?: [string, string][]
	body?: Uint8Array
}
export interface FetchResponse {
	status: number
	headers: [string, string][]
	body: Uint8Array
}
export interface StudioBridge {
	fetch(request: FetchRequest): Promise<FetchResponse>
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

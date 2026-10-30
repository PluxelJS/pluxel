import { useSyncExternalStore } from 'react'
import type { Editor } from '@tiptap/core'
import { RpcStub, RpcTarget } from 'capnweb'
import type { SourcePosition, TypstNavigationPoint } from '@pluxel/plugin-typst/browser'
import {
	findTypstSourcePosition,
	findTypstEditorPosition,
	type TypstSourceProject,
} from '@pluxel/plugin-typst/source/browser'

import {
	isStudioError,
	type CompileResult,
	type DocumentDescription,
	type JsonObject,
	type PreviewResult,
	type ProjectSummary,
	type TextFile,
	type WorkspaceTree,
	type EditorDraft,
	type DocumentInput,
	type BodyEditorParticipant,
	type BodyEditorAttachment,
} from '../shared/contracts'
import { sourceFiles } from '../shared/source-files'
import { api, onDesktopConnectionChange } from './api'
import { isPaneVisible } from './source-navigation'

const disconnectedMessage = '后端连接已中断，等待恢复。'

interface PreviewRegistration {
	entry: string
	element: HTMLElement
	result(): PreviewResult | null
	reveal(position: SourcePosition): boolean
}

export interface FileState extends TextFile {
	saved: string
	dirty: boolean
	saving: boolean
	error?: string
	token: number
	external: number
	missing?: boolean
}
export interface DocumentState {
	assets?: DocumentInput['assets']
	entry: string
	result?: CompileResult
	preview?: PreviewResult
	/** Exact authored sources captured for the visible compile; never editable. */
	compiledSources?: Readonly<Record<string, string>>
	description?: DocumentDescription
	fields: DocumentDescription['fields']
	data: JsonObject
	editor?: EditorDraft
	storageVersion?: string | null
	inputLoaded?: boolean
	busy: boolean
	error?: string
	diagnostics: CompileResult['diagnostics']
	generation: number
	inputDirty?: boolean
	inputSaving?: boolean
	inputToken?: number
	inputError?: string
	/** Read-back snapshot; local input stays intact until the user resolves the conflict. */
	inputConflict?: DocumentInput
	/** Replacing the whole draft also replaces native editor history and staged candidates. */
	inputEpoch?: number
	bodyLocked?: boolean
}

function inputContent({ data, editor }: Pick<DocumentInput, 'data' | 'editor'>): string {
	return JSON.stringify({ data, editor }, (_key, value: unknown) =>
		value && typeof value === 'object' && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: value,
	)
}
function sameSourceFiles(
	left: Readonly<Record<string, string | Uint8Array>>,
	right: Readonly<Record<string, string | Uint8Array>>,
): boolean {
	return (
		Object.keys(left).length === Object.keys(right).length &&
		Object.entries(right).every(([path, value]) => {
			const current = left[path]
			return typeof value === 'string'
				? current === value
				: current instanceof Uint8Array &&
						current.byteLength === value.byteLength &&
						current.every((byte, index) => byte === value[index])
		})
	)
}
export interface AssistantDraft {
	text: string
	modelKey?: string | null
}
export interface AssistantUiState {
	drafts: Map<string, AssistantDraft>
	activeThreadId: string | null
}
export class WorkspaceController {
	tree?: WorkspaceTree
	files = new Map<string, FileState>()
	documents = new Map<string, DocumentState>()
	/** Docking and closing the tool do not own project conversation drafts. */
	readonly assistantState: AssistantUiState = { drafts: new Map(), activeThreadId: null }
	error = ''
	/** A user navigation request; object identity lets repeated searches reveal the same line. */
	location?: SourcePosition & { endLine?: number; endColumn?: number }
	bodyLocation?: {
		entry: string
		path: string
		from: number
		to: number
		serial: number
		source?: { line: number; column: number }
	}
	private previews = new Set<PreviewRegistration>()
	private preferredPreview?: string
	private openSource?: (path: string) => Promise<boolean>
	private documentUsers = new Map<string, number>()
	private documentGeneration = 0
	private navigationSerial = 0
	private serial = 0
	private listeners = new Set<() => void>()
	private saves = new Map<string, Promise<void>>()
	private timers = new Map<string, ReturnType<typeof setTimeout>>()
	private inputSaves = new Map<string, Promise<void>>()
	private compiles = new Map<string, Promise<void>>()
	private compilePending = new Set<string>()
	private polling?: ReturnType<typeof setInterval>
	private disconnectListener?: () => void
	private refreshing?: Promise<boolean>
	private closed = false
	private bodyAttachment?: BodyEditorAttachment
	private connectionGeneration = 0
	readonly sourceProjects = new Map<string, TypstSourceProject>()
	private sourceSubscriptions = new Map<string, () => void>()
	private sourceLoads = new Map<string, { key: string; promise: Promise<TypstSourceProject> }>()
	private syncingSource = new Set<string>()
	private bodyEditors = new Map<string, Map<string, Set<Editor>>>()
	private bodyLocks = new Map<
		string,
		{ lease: string; token: number; content: string; editability: Map<Editor, boolean> }
	>()
	constructor(readonly project: ProjectSummary) {}
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	snapshot = () => this.serial
	emit() {
		if (!this.closed) {
			++this.serial
			for (const listener of this.listeners) listener()
		}
	}
	start() {
		if (this.closed || this.polling) return
		this.disconnectListener = onDesktopConnectionChange(async (connected) => {
			if (connected && this.error === disconnectedMessage) this.error = ''
			for (const entry of this.bodyLocks.keys()) this.unlockBody(entry)
			// Retain visible pages and drafts, but never export or navigate an old generation.
			for (const [entry, document] of this.documents) {
				this.documents.set(entry, {
					...document,
					result: undefined,
					busy: false,
					generation: ++this.documentGeneration,
					error: !connected ? disconnectedMessage : '后端已更新，正在恢复当前草稿的预览。',
				})
			}
			this.emit()
			if (connected) {
				void this.attachBodyEditor()
				for (const entry of [...this.documentUsers.keys()].sort(
					(left, right) =>
						Number(left === this.preferredPreview) - Number(right === this.preferredPreview),
				))
					await this.compile(entry)
			}
		})
		void this.attachBodyEditor()
		void this.refresh()
		this.polling = setInterval(() => {
			void this.refresh()
		}, 1500)
	}
	dispose() {
		this.closed = true
		++this.connectionGeneration
		void this.bodyAttachment?.close().catch(() => {})
		this.bodyAttachment = undefined
		for (const entry of this.bodyLocks.keys()) this.unlockBody(entry)
		this.disconnectListener?.()
		clearInterval(this.polling)
		for (const timer of this.timers.values()) clearTimeout(timer)
		for (const release of this.sourceSubscriptions.values()) release()
		this.sourceLoads.clear()
		this.listeners.clear()
		this.previews.clear()
		this.documentUsers.clear()
		this.assistantState.drafts.clear()
		this.assistantState.activeThreadId = null
		this.openSource = undefined
		++this.navigationSerial
	}
	private async attachBodyEditor() {
		const generation = ++this.connectionGeneration
		const participant = new RpcStub(new WorkspaceBodyParticipant(this))
		try {
			const attachment = await api.attachBodyEditor({ projectId: this.project.id }, participant)
			if (this.closed || generation !== this.connectionGeneration) {
				await attachment.close()
				return
			}
			this.bodyAttachment = attachment
		} catch (cause) {
			if (!this.closed && generation === this.connectionGeneration) {
				this.error = `正文 Agent 连接失败：${String(cause)}`
				this.emit()
			}
		} finally {
			participant[Symbol.dispose]()
		}
	}
	registerBodyEditor(entry: string, path: string, editor: Editor): () => void {
		let paths = this.bodyEditors.get(entry)
		if (!paths) this.bodyEditors.set(entry, (paths = new Map()))
		let editors = paths.get(path)
		if (!editors) paths.set(path, (editors = new Set()))
		editors.add(editor)
		return () => {
			editors.delete(editor)
			if (editors.size === 0) paths.delete(path)
			if (paths.size === 0) this.bodyEditors.delete(entry)
		}
	}
	async captureBody({ entry }: { entry: string }): ReturnType<BodyEditorParticipant['capture']> {
		if (this.closed) throw new Error('项目已关闭')
		if (!this.documents.has(entry)) return null
		if (this.bodyLocks.has(entry)) throw new Error('正文操作正在进行')
		const editability = new Map<Editor, boolean>()
		for (const editors of this.bodyEditors.get(entry)?.values() ?? [])
			for (const editor of editors) {
				if (editor.view.composing) throw new Error('请完成输入法组合后重试正文操作')
				editability.set(editor, editor.isEditable)
			}
		const lease = crypto.randomUUID()
		this.bodyLocks.set(entry, { lease, token: 0, content: '', editability })
		for (const editor of editability.keys()) editor.setEditable(false, false)
		this.documents.set(entry, { ...this.documents.get(entry)!, bodyLocked: true })
		clearTimeout(this.timers.get(`input:${entry}`))
		clearTimeout(this.timers.get(`compile:${entry}`))
		this.emit()
		try {
			await this.inputSaves.get(entry)
			await this.compiles.get(entry)
			if (this.bodyLocks.get(entry)?.lease !== lease)
				throw new Error('正文操作期间连接已改变，请重试')
			const current = this.documents.get(entry)
			if (this.closed || !current?.inputLoaded || !current.editor)
				throw new Error('正文尚未载入或初始化')
			if (current.inputConflict || current.inputError)
				throw new Error('请先解决正文保存失败或版本冲突')
			if ([...this.files.values()].some((file) => file.dirty || file.saving || file.missing))
				throw new Error('请先保存或处理模板源码草稿，再编辑正文')
			const input = structuredClone({
				data: current.data,
				editor: current.editor,
				assets: current.assets,
				storageVersion: current.storageVersion ?? null,
			})
			const token = current.inputToken ?? 0
			this.bodyLocks.set(entry, { lease, token, content: inputContent(input), editability })
			return { lease, input, clientRevision: token }
		} catch (cause) {
			this.unlockBody(entry, lease)
			throw cause
		}
	}
	async finishBody({ entry, lease, commit }: Parameters<BodyEditorParticipant['finish']>[0]) {
		const lock = this.bodyLocks.get(entry)
		if (!lock || lock.lease !== lease) throw new Error('正文编辑会话已改变；已提交内容需要重新载入')
		try {
			if (!commit) return
			const current = this.documents.get(entry)
			if (
				this.closed ||
				!current ||
				inputContent(current) !== lock.content ||
				(current.inputToken ?? 0) !== lock.token
			)
				throw new Error('当前正文已改变；保留本地草稿并重新载入已提交内容')
			const sourceProject = this.sourceProjects.get(entry)
			if (sourceProject && commit.input.editor) {
				const before = sourceProject.snapshot().files
				const patches = Object.entries(commit.input.editor.files)
					.filter(([path, text]) => before[path] !== text)
					.map(([path, text]) => ({
						path,
						from: 0,
						to: new TextEncoder().encode(typeof before[path] === 'string' ? before[path] : '')
							.length,
						text,
					}))
				this.syncingSource.add(entry)
				try {
					const result = sourceProject.apply({ baseRevision: sourceProject.revision, patches })
					if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('\n'))
				} finally {
					this.syncingSource.delete(entry)
				}
			}
			if (commit.input.editor)
				this.syncInputFiles(entry, commit.input.editor.files, commit.input.editor.files)

			this.documents.set(entry, {
				...current,
				...structuredClone(commit.input),
				inputToken: lock.token + 1,
				inputDirty: false,
				inputError: undefined,
				inputConflict: undefined,
				result: commit.compile ?? current.result,
				preview: commit.preview ?? current.preview,
				compiledSources: commit.preview ? commit.input.editor?.files : current.compiledSources,
				diagnostics: commit.compile?.diagnostics ?? [],
				error: commit.previewError,
				busy: false,
			})
			this.compilePending.delete(entry)
		} catch (cause) {
			const current = this.documents.get(entry)
			if (commit && current)
				this.documents.set(entry, {
					...current,
					inputConflict: structuredClone(commit.input),
					inputError: `正文已保存，但当前编辑器未能接纳：${String(cause)}`,
				})
			throw cause
		} finally {
			this.unlockBody(entry, lease)
		}
	}
	private unlockBody(entry: string, lease?: string) {
		const lock = this.bodyLocks.get(entry)
		if (!lock || (lease !== undefined && lock.lease !== lease)) return
		this.bodyLocks.delete(entry)
		for (const [editor, editable] of lock.editability)
			if (!editor.isDestroyed) editor.setEditable(editable, false)
		const current = this.documents.get(entry)
		if (current) {
			this.documents.set(entry, { ...current, bodyLocked: false })
			if (current.inputDirty && !this.closed) this.changedInput(entry)
		}
		this.emit()
	}
	connectSourceNavigation(open: (path: string) => Promise<boolean>) {
		this.openSource = open
		return () => {
			if (this.openSource === open) this.openSource = undefined
		}
	}
	preferPreview(entry: string) {
		this.preferredPreview = entry
	}
	registerPreview(preview: PreviewRegistration) {
		this.previews.add(preview)
		return () => {
			this.previews.delete(preview)
		}
	}
	isNavigationCurrent(result: PreviewResult): boolean {
		const document = this.documents.get(result.entry)
		if (
			this.closed ||
			document?.preview !== result ||
			document.busy ||
			document.error ||
			result.clientRevision !== (document.inputToken ?? 0) ||
			!result.preview.navigation ||
			Object.keys(result.sourceVersions).length === 0
		)
			return false
		return Object.entries(result.sourceVersions).every(([path, version]) => {
			const file = this.files.get(path)
			const captured = document.compiledSources?.[path]
			if (
				captured !== undefined &&
				document.editor?.files[path] === captured &&
				file?.content === captured
			)
				return !file.dirty && !file.saving && !file.missing && !file.error

			if (file)
				return (
					!file.dirty && !file.saving && !file.missing && !file.error && file.version === version
				)
			return this.tree?.entries.some((entry) => entry.path === path && entry.version === version)
		})
	}
	revealPreview(position: SourcePosition) {
		if (!position.path.endsWith('.typ')) return
		const candidates = [...this.previews].filter((preview) => {
			const result = preview.result()
			return (
				isPaneVisible(preview.element) &&
				result &&
				this.isNavigationCurrent(result) &&
				result.preview.navigation?.points.some((point) => point.path === position.path)
			)
		})
		// An imported source can belong to several documents. Do not move all previews.
		const matching = candidates.filter((preview) => preview.entry === this.preferredPreview)
		const preview =
			matching.length === 1 ? matching[0] : candidates.length === 1 ? candidates[0] : undefined
		if (preview?.reveal(position)) this.preferredPreview = preview.entry
	}
	revealBodySource(entry: string, path: string, position: number) {
		const result = this.documents.get(entry)?.preview,
			project = this.sourceProjects.get(entry)
		if (!result || !project || !this.isNavigationCurrent(result)) return
		const source = findTypstSourcePosition({ projection: project.open(path), position })
		if (source) {
			this.preferredPreview = entry
			this.revealPreview(source)
		}
	}
	async revealReference(entry: string, path: string, position: number) {
		const project = this.sourceProjects.get(entry)
		if (!project) return
		if (
			this.documents.get(entry)?.description?.editor?.sources.some((source) => source.path === path)
		) {
			this.bodyLocation = {
				entry,
				path,
				from: position,
				to: position,
				serial: ++this.navigationSerial,
			}
			this.emit()
			return
		}
		const revision = project.revision
		const source = findTypstSourcePosition({ projection: project.open(path), position })
		if (!source || !this.openSource) return
		try {
			if (
				!(await this.openSource(path)) ||
				this.sourceProjects.get(entry) !== project ||
				project.revision !== revision
			)
				return
			this.location = source
			this.emit()
		} catch (cause) {
			this.error = String(cause)
			this.emit()
		}
	}

	async revealSource(result: PreviewResult, point: TypstNavigationPoint) {
		if (!this.isNavigationCurrent(result) || !point.path.endsWith('.typ')) return
		const serial = ++this.navigationSerial
		this.preferredPreview = result.entry
		const project = this.sourceProjects.get(result.entry)
		if (
			project &&
			this.documents
				.get(result.entry)
				?.description?.editor?.sources.some((source) => source.path === point.path)
		) {
			const position = findTypstEditorPosition({
				projection: project.open(point.path),
				sourcePosition: point,
			})
			if (position !== undefined) {
				this.bodyLocation = {
					entry: result.entry,
					path: point.path,
					from: position,
					to: position,
					serial,
					source: { line: point.line, column: point.column },
				}
				this.emit()
			}
			return
		}
		if (!this.openSource) return
		try {
			if (!(await this.openSource(point.path))) return
			if (serial !== this.navigationSerial || !this.isNavigationCurrent(result)) return
			this.location = {
				path: point.path,
				line: point.line,
				column: point.column,
				endLine: point.endLine,
				endColumn: point.endColumn,
			}
			this.emit()
		} catch (cause) {
			if (serial !== this.navigationSerial || this.closed) return
			this.error = cause instanceof Error ? cause.message : String(cause)
			this.emit()
		}
	}
	/** Reads a snapshot started after this call; false stops dependent filesystem operations. */
	async refresh(): Promise<boolean> {
		if (this.closed) return false
		if (this.refreshing) {
			// An existing read can predate the caller's write. Wait, then share the next read.
			await this.refreshing
			if (this.closed) return false
			if (this.refreshing) return this.refreshing
		}
		const connection = api
		const generation = this.connectionGeneration
		this.refreshing = (async () => {
			try {
				const tree = await connection.getTree({ projectId: this.project.id })
				if (this.closed) return false
				const changed = tree.revision !== this.tree?.revision
				if (!changed) {
					if (this.tree?.configError !== tree.configError) {
						this.tree = tree
						this.emit()
					}
					return true
				}
				await Promise.all(
					tree.entries
						.filter((entry) => entry.kind === 'file' && !entry.binary)
						.map(async (entry) => {
							const previous = this.files.get(entry.path)
							if (previous?.version === entry.version && !previous.missing) return
							if (previous?.dirty || previous?.saving) {
								if (previous.version !== entry.version && !previous.saving) {
									previous.error = '文件已在外部修改，草稿已保留。请复制需要的修改后重新载入。'
								}
								return
							}
							const next = await api.readFile({ projectId: this.project.id, path: entry.path })
							if (this.closed || this.files.get(entry.path) !== previous) return
							const owner = this.inputOwner(entry.path)
							const inputDraft = owner?.inputDirty || owner?.inputSaving ? owner : undefined
							this.files.set(entry.path, {
								...next,
								// Body/data drafts retain their sole save owner and original workspace CAS.
								content: inputDraft?.editor?.files[entry.path] ?? next.content,
								saved: next.content,
								dirty: false,
								saving: false,
								token: previous?.token ?? 0,
								external: (previous?.external ?? 0) + 1,
							})
						}),
				)
				if (this.closed) return false
				for (const [path, file] of this.files)
					if (!tree.entries.some((entry) => entry.path === path))
						this.files.set(path, {
							...file,
							missing: true,
							error: '文件已在外部删除或移动。草稿仍保留，可复制后关闭标签。',
						})
				this.tree = tree
				this.emit()
				// Respect the native session budget and leave the current report retained last.
				for (const entry of [...this.documentUsers.keys()].sort(
					(left, right) =>
						Number(left === this.preferredPreview) - Number(right === this.preferredPreview),
				))
					await this.compile(entry)
				return true
			} catch (cause) {
				if (this.closed || connection !== api || generation !== this.connectionGeneration)
					return false
				if (
					isStudioError(cause) &&
					(cause.code === 'BACKEND_UNAVAILABLE' || cause.code === 'CLOSED')
				) {
					if (!this.error) this.error = disconnectedMessage
				} else this.error = cause instanceof Error ? cause.message : String(cause)
				this.emit()
				return false
			} finally {
				this.refreshing = undefined
			}
		})()
		return this.refreshing
	}
	textFiles() {
		return Object.fromEntries(
			[...this.files]
				.filter(([, file]) => !file.missing)
				.map(([path, file]) => [path, file.content]),
		)
	}
	/** The project revision owns body/data identity; these inputs cover host-owned source drafts and resources. */
	draftRevision(entry: string): string {
		const writable = new Set([
			...(this.documents.get(entry)?.description?.editor?.sources.map((source) => source.path) ??
				[]),
			entry.slice(0, entry.lastIndexOf('/') + 1) + 'data.json',
		])
		return JSON.stringify([
			this.sourceProjects.get(entry)?.revision,
			this.tree?.entries
				.filter((file) => file.kind === 'file' && !writable.has(file.path))
				.map((file) => [file.path, file.version]),
			[...this.files]
				.filter(([, file]) => file.dirty || file.missing)
				.map(([path, file]) => [path, file.token, file.missing]),
		])
	}
	/** The loaded report owns all saves and replacements of its body and adjacent data file. */
	inputOwner(path: string): DocumentState | undefined {
		return [...this.documents.values()].find(
			(document) =>
				document.editor &&
				(document.description?.editor?.sources.some((source) => source.path === path) ||
					path === document.entry.slice(0, document.entry.lastIndexOf('/') + 1) + 'data.json'),
		)
	}
	edit(path: string, content: string) {
		const current = this.files.get(path)
		if (!current || current.missing) return
		const document = this.inputOwner(path)
		if (document) {
			const entry = document.entry
			if (this.bodyLocks.has(entry)) return
			const project = this.sourceProjects.get(entry)
			if (project) {
				const source = document.editor!.files[path] ?? ''
				const result = project.apply({
					baseRevision: project.revision,
					patches: [{ path, from: 0, to: new TextEncoder().encode(source).length, text: content }],
				})
				if (!result.ok) {
					this.error = result.issues.map((issue) => issue.message).join('\n')
					this.emit()
				}
			} else this.writeSources(entry, { ...document.editor!.files, [path]: content })
			return
		}
		this.files.set(path, {
			...current,
			content,
			dirty: content !== current.saved,
			token: current.token + 1,
		})
		this.emit()
		clearTimeout(this.timers.get(path))
		this.timers.set(
			path,
			setTimeout(() => {
				void this.save(path)
			}, 650),
		)
	}
	async save(path: string): Promise<void> {
		const owner = this.inputOwner(path)
		if (owner) return this.saveInput(owner.entry)
		const previous = this.saves.get(path)
		if (previous) {
			await previous
			if (this.files.get(path)?.dirty && !this.files.get(path)?.error) return this.save(path)
			return
		}
		const file = this.files.get(path)
		if (!file?.dirty || file.missing) return
		const content = file.content
		this.files.set(path, { ...file, saving: true, error: undefined })
		this.emit()
		let saved = false
		const work = (async () => {
			try {
				const next = await api.writeFile({
					projectId: this.project.id,
					path,
					content,
					expectedVersion: file.version,
				})
				const current = this.files.get(path)!
				this.files.set(path, {
					...current,
					version: next.version,
					saved: content,
					dirty: current.content !== content,
					saving: false,
				})
				this.emit()
				saved = true
			} catch (cause) {
				const current = this.files.get(path)!
				this.files.set(path, {
					...current,
					saving: false,
					error:
						isStudioError(cause) && cause.code === 'REVISION_CONFLICT'
							? '磁盘文件已修改，保存冲突。草稿已保留；复制所需内容后重新载入。'
							: String(cause),
				})
				this.emit()
			} finally {
				this.saves.delete(path)
			}
		})()
		this.saves.set(path, work)
		await work
		// The write queue must settle before refresh can compile a newly opened input owner.
		if (saved) await this.refresh()
	}
	/** Explicitly discard this resource's shared draft, including an externally removed file. */
	async discard(path: string) {
		const owner = this.inputOwner(path)
		if (owner) return this.reloadInput(owner.entry)
		clearTimeout(this.timers.get(path))
		await this.saves.get(path)
		const file = this.files.get(path)
		if (!file?.dirty || this.closed) return
		if (!file.missing) return this.reload(path)
		this.files.set(path, { ...file, content: file.saved, dirty: false, token: file.token + 1 })
		this.emit()
	}
	async reload(path: string) {
		const owner = this.inputOwner(path)
		if (owner) return this.reloadInput(owner.entry)
		clearTimeout(this.timers.get(path))
		await this.saves.get(path)
		const next = await api.readFile({ projectId: this.project.id, path })
		const token = (this.files.get(path)?.token ?? 0) + 1
		this.files.set(path, {
			...next,
			saved: next.content,
			dirty: false,
			saving: false,
			token,
			external: (this.files.get(path)?.external ?? 0) + 1,
		})
		this.emit()
	}
	/** Mounted views share input and compilation. The last view releases clean cached output. */
	retainDocument(entry: string): () => void {
		if (this.closed) throw new Error('Cannot retain a document in a closed workspace')
		this.documentUsers.set(entry, (this.documentUsers.get(entry) ?? 0) + 1)
		if (!this.documents.has(entry)) {
			this.documents.set(entry, {
				entry,
				fields: [],
				data: {},
				diagnostics: [],
				busy: false,
				generation: 0,
			})
			this.emit()
			void this.compile(entry)
		}
		let released = false
		return () => {
			if (released) return
			released = true
			const users = (this.documentUsers.get(entry) ?? 1) - 1
			if (users) this.documentUsers.set(entry, users)
			else {
				this.documentUsers.delete(entry)
				// React effect replay reconnects before this task; preserve the same resource.
				queueMicrotask(() => this.releaseUnusedDocument(entry))
			}
		}
	}
	private releaseUnusedDocument(entry: string) {
		const document = this.documents.get(entry)
		if (
			this.bodyLocks.has(entry) ||
			this.documentUsers.has(entry) ||
			document?.inputDirty ||
			document?.inputSaving
		)
			return
		if (this.documents.delete(entry)) {
			this.sourceSubscriptions.get(entry)?.()
			this.sourceLoads.delete(entry)
			this.emit()
		}
	}
	isDirty() {
		return (
			[...this.files.values()].some((file) => file.dirty) ||
			[...this.documents.values()].some((document) => document.inputDirty)
		)
	}
	/** One in-flight compilation and one latest pending snapshot per document. */
	async compile(entry: string): Promise<void> {
		if (this.closed || this.bodyLocks.has(entry) || !this.documents.has(entry)) return
		const pending = this.compiles.get(entry)
		if (pending) {
			this.compilePending.add(entry)
			return pending
		}
		const work = (async () => {
			do {
				this.compilePending.delete(entry)
				await this.compileSnapshot(entry)
			} while (
				!this.closed &&
				!this.bodyLocks.has(entry) &&
				this.documents.has(entry) &&
				this.compilePending.has(entry)
			)
		})()
		this.compiles.set(entry, work)
		try {
			await work
		} finally {
			this.compiles.delete(entry)
		}
	}
	private async compileSnapshot(entry: string) {
		const previous = this.documents.get(entry)
		if (!previous || this.closed) return
		const generation = ++this.documentGeneration
		this.documents.set(entry, { ...previous, busy: true, generation })
		this.emit()
		let clientRevision = previous.inputToken ?? 0
		try {
			const target = { projectId: this.project.id, entry }
			const description = await api.describeDocument(target)
			if (this.closed || this.documents.get(entry)?.generation !== generation) return
			let current = this.documents.get(entry)!
			const templateChanged =
				current.description && current.description.sourceRevision !== description.sourceRevision
			if (
				!current.inputLoaded ||
				(templateChanged && !current.inputDirty && !current.inputSaving)
			) {
				const initial = !current.inputLoaded
				const paths = [
					...(description.editor?.sources.map((source) => source.path) ?? []),
					entry.slice(0, entry.lastIndexOf('/') + 1) + 'data.json',
				]
				if (initial) {
					for (const path of paths) clearTimeout(this.timers.get(path))
					await Promise.all(paths.map((path) => this.saves.get(path)))
					if (this.closed || this.documents.get(entry)?.generation !== generation) return
				}
				const versions = paths.map((path) => this.files.get(path)?.version)
				const stored = await api.getInput(target)
				if (this.closed || this.documents.get(entry)?.generation !== generation) return
				if (
					initial &&
					paths.some(
						(path, index) =>
							this.saves.has(path) || this.files.get(path)?.version !== versions[index],
					)
				)
					throw Object.assign(
						new Error('文件在载入报表期间仍有保存变化；草稿已保留，请重新载入。'),
						{ code: 'REVISION_CONFLICT' },
					)
				current = this.documents.get(entry)!
				let editor =
					current.inputDirty && stored.editor
						? (current.editor ?? {
								files: {
									...stored.editor.files,
									[entry.slice(0, entry.lastIndexOf('/') + 1) + 'data.json']:
										JSON.stringify(current.data, null, 2) + '\n',
								},
							})
						: stored.editor
				let data = current.inputDirty
					? current.data
					: stored.storageVersion === null
						? structuredClone(description.defaults)
						: stored.data
				const drafts = initial
					? paths.flatMap((path) => {
							const file = this.files.get(path)
							return file?.dirty ? [file] : []
						})
					: []
				const changed = drafts.filter((file) => file.content !== stored.editor?.files[file.path])
				if (drafts.length > 0) {
					if (!editor) throw new Error('报表尚无完整输入快照，文件草稿已保留。')
					editor = {
						files: {
							...editor.files,
							...Object.fromEntries(drafts.map((file) => [file.path, file.content])),
						},
					}
					try {
						data = JSON.parse(editor.files[paths.at(-1)!] ?? '{}')
						if (!data || typeof data !== 'object' || Array.isArray(data))
							throw new Error('Expected a JSON object')
					} catch (cause) {
						throw Object.assign(
							new Error('data.json 草稿不是有效 JSON 对象；请在文件视图修复后重新载入报表。', {
								cause,
							}),
							{ code: 'INVALID_INPUT' },
						)
					}
				}
				const conflict = changed.some((file) => file.saved !== stored.editor?.files[file.path])
				const inputError = changed
					.map((file) => file.error)
					.filter(Boolean)
					.join('\n')
				this.documents.set(entry, {
					...current,
					data,
					editor,
					description,
					fields: description.fields,
					...(drafts.length > 0
						? {
								inputDirty: current.inputDirty || changed.length > 0,
								inputToken: (current.inputToken ?? 0) + Number(changed.length > 0),
								inputError:
									inputError ||
									(conflict
										? '文件已在外部修改；原文件草稿已保留，请选择要保留的版本。'
										: undefined),
								inputConflict: conflict ? structuredClone(stored) : undefined,
							}
						: {}),
					assets: current.inputLoaded && current.inputDirty ? current.assets : stored.assets,
					storageVersion:
						current.inputLoaded && current.inputDirty
							? current.storageVersion
							: stored.storageVersion,
					inputLoaded: true,
				})
				for (const file of drafts) {
					clearTimeout(this.timers.get(file.path))
					this.files.set(file.path, { ...file, dirty: false, error: undefined })
				}
				this.replaceSourceProject(entry, this.documents.get(entry)!, stored.editor?.files)
				this.emit()
				// An edit made while the initial read was pending keeps its content, but only
				// saves after the authoritative storage version and existing source files are known.
				const adopted = this.documents.get(entry)!
				if (adopted.inputDirty && !adopted.inputError && !adopted.inputConflict)
					this.changedInput(entry)
			}
			current = this.documents.get(entry)!
			// New fields become editable only after their matching input snapshot is accepted.
			current = {
				...current,
				fields: description.fields,
				description,
				inputToken: (current.inputToken ?? 0) + (templateChanged ? 1 : 0),
			}
			this.documents.set(entry, current)
			this.emit()
			clientRevision = current.inputToken ?? 0
			const data = structuredClone(current.data)
			const editor = current.editor && structuredClone(current.editor)
			const result = await api.compile({ ...target, data, editor, clientRevision })
			if (this.closed || this.documents.get(entry)?.generation !== generation) return
			if ((this.documents.get(entry)?.inputToken ?? 0) !== clientRevision) {
				this.compilePending.add(entry)
				return
			}
			const preview = await api.getPreview({ ...target, revision: result.revision })
			if (this.closed || this.documents.get(entry)?.generation !== generation) return
			if ((this.documents.get(entry)?.inputToken ?? 0) !== clientRevision) {
				this.compilePending.add(entry)
				return
			}
			if (
				description.sourceRevision !== result.sourceRevision ||
				result.clientRevision !== clientRevision
			)
				throw Object.assign(new Error('源码或草稿在编译期间已改变，请刷新预览。'), {
					code: 'REVISION_CONFLICT',
				})
			this.documents.set(entry, {
				...this.documents.get(entry)!,
				result,
				preview,
				compiledSources: editor?.files,
				diagnostics: result.diagnostics,
				busy: false,
				error: undefined,
				generation,
			})
		} catch (cause) {
			if (this.closed || this.documents.get(entry)?.generation !== generation) return
			if ((this.documents.get(entry)?.inputToken ?? 0) !== clientRevision) {
				this.compilePending.add(entry)
				return
			}
			const current = this.documents.get(entry)!
			const detail = isStudioError(cause) ? cause : undefined
			this.documents.set(entry, {
				...current,
				busy: false,
				diagnostics: detail?.diagnostics ?? [],
				error:
					detail?.code === 'REVISION_CONFLICT'
						? '预览版本已改变，仍显示上次成功画面。请刷新预览。'
						: (detail?.message ?? String(cause)),
			})
		}
		this.emit()
	}
	private changedInput(entry: string) {
		this.emit()
		const key = `input:${entry}`
		clearTimeout(this.timers.get(key))
		this.timers.set(
			key,
			setTimeout(() => {
				void this.saveInput(entry)
			}, 400),
		)
		const compileKey = `compile:${entry}`
		clearTimeout(this.timers.get(compileKey))
		this.timers.set(
			compileKey,
			setTimeout(() => {
				if (this.documentUsers.has(entry)) void this.compile(entry)
			}, 180),
		)
	}
	/** Split views share the same asynchronously initialized source authority and history. */
	loadSourceProject(
		entry: string,
		key: string,
		create: () => Promise<TypstSourceProject>,
	): Promise<TypstSourceProject> {
		const pending = this.sourceLoads.get(entry)
		if (pending?.key === key) return pending.promise
		const promise = create()
			.then((project) => {
				if (this.closed || this.sourceLoads.get(entry)?.promise !== promise) return project
				const latest = this.documents.get(entry)
				if (latest?.editor) {
					const files = sourceFiles(latest)
					const snapshot = project.snapshot().files
					if (!sameSourceFiles(snapshot, files)) {
						const replaced = project.replace({
							baseRevision: project.revision,
							files,
						})
						if (!replaced.ok)
							throw new Error(replaced.issues.map((issue) => issue.message).join('\n'))
					}
				}
				this.registerSourceProject(entry, project)
				return project
			})
			.catch((cause) => {
				if (this.sourceLoads.get(entry)?.promise === promise) this.sourceLoads.delete(entry)
				throw cause
			})
		this.sourceLoads.set(entry, { key, promise })
		return promise
	}

	registerSourceProject(entry: string, project: TypstSourceProject) {
		this.sourceSubscriptions.get(entry)?.()
		this.sourceProjects.set(entry, project)
		const unsubscribe = project.subscribe(() => {
			if (!this.syncingSource.has(entry))
				this.writeSources(
					entry,
					Object.fromEntries(
						Object.entries(project.snapshot().files).filter(
							(file): file is [string, string] => typeof file[1] === 'string',
						),
					),
				)
		})
		const release = () => {
			unsubscribe()
			if (this.sourceProjects.get(entry) === project) {
				this.sourceProjects.delete(entry)
				this.sourceSubscriptions.delete(entry)
			}
		}
		this.sourceSubscriptions.set(entry, release)
		return release
	}

	private replaceSourceProject(
		entry: string,
		input: Pick<DocumentInput, 'editor' | 'assets'>,
		savedFiles?: Readonly<Record<string, string>>,
	) {
		if (!input.editor) return
		const project = this.sourceProjects.get(entry)
		if (project) {
			const files = sourceFiles(input)
			if (!sameSourceFiles(project.snapshot().files, files)) {
				this.syncingSource.add(entry)
				try {
					const result = project.replace({ baseRevision: project.revision, files })
					if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join('\n'))
				} finally {
					this.syncingSource.delete(entry)
				}
			}
		}
		this.syncInputFiles(entry, input.editor.files, savedFiles)
	}
	writeSources(entry: string, files: Record<string, string>) {
		if (this.bodyLocks.has(entry)) return
		const current = this.documents.get(entry)
		if (!current?.editor) return
		let data = current.data
		try {
			data = JSON.parse(files[entry.slice(0, entry.lastIndexOf('/') + 1) + 'data.json'] ?? '{}')
		} catch {}
		this.documents.set(entry, {
			...current,
			data,
			editor: { files: { ...files } },
			inputDirty: true,
			inputError: undefined,
			inputToken: (current.inputToken ?? 0) + 1,
		})
		this.syncInputFiles(entry, files)
		this.changedInput(entry)
	}

	/** Monaco displays the same writable sources as the body's input owner. */
	private syncInputFiles(
		entry: string,
		files: Readonly<Record<string, string>>,
		savedFiles?: Readonly<Record<string, string>>,
	) {
		const paths = [
			...(this.documents.get(entry)?.description?.editor?.sources.map((source) => source.path) ??
				[]),
			entry.slice(0, entry.lastIndexOf('/') + 1) + 'data.json',
		]
		for (const path of paths) {
			const source = files[path]
			const file = this.files.get(path)
			if (!file || file.dirty || file.saving || source === undefined) continue
			const saved = savedFiles?.[path] ?? file.saved
			if (file.content !== source || file.saved !== saved)
				this.files.set(path, {
					...file,
					content: source,
					saved,
					external: file.external + Number(file.content !== source),
					token: file.token + Number(file.content !== source),
				})
		}
	}

	async writeData(entry: string, data: JsonObject) {
		if (this.bodyLocks.has(entry)) return
		const current = this.documents.get(entry)
		if (!current) return
		const path = entry.slice(0, entry.lastIndexOf('/') + 1) + 'data.json',
			text = JSON.stringify(data, null, 2) + '\n'
		const project = this.sourceProjects.get(entry),
			source = current.editor?.files[path]
		if (project && source !== undefined) {
			const applied = project.apply({
				baseRevision: project.revision,
				patches: [{ path, from: 0, to: new TextEncoder().encode(source).length, text }],
			})
			if (!applied.ok) throw new Error(applied.issues.map((issue) => issue.message).join('\n'))
			return
		}
		if (current.editor) {
			this.writeSources(entry, { ...current.editor.files, [path]: text })
			return
		}
		this.documents.set(entry, {
			...current,
			data,
			inputDirty: true,
			inputError: undefined,
			inputToken: (current.inputToken ?? 0) + 1,
		})
		this.changedInput(entry)
	}

	async saveInput(entry: string): Promise<void> {
		if (this.bodyLocks.has(entry)) return
		const pending = this.inputSaves.get(entry)
		if (pending) {
			await pending
			if (this.documents.get(entry)?.inputDirty && !this.documents.get(entry)?.inputError)
				return this.saveInput(entry)
			return
		}
		const current = this.documents.get(entry)
		if (!current?.inputDirty || !current.inputLoaded || current.inputConflict) return
		return this.persistInput(entry, current.storageVersion ?? null)
	}

	async resolveInputConflict(entry: string, choice: 'local' | 'saved'): Promise<void> {
		const current = this.documents.get(entry)
		const saved = current?.inputConflict
		if (!current || !saved || current.inputSaving || this.bodyLocks.has(entry)) return
		if (choice === 'local') {
			// Explicit replacement still uses CAS. A further writer requires a fresh decision.
			return this.persistInput(entry, saved.storageVersion)
		}
		return this.acceptSavedInput(entry, saved)
	}

	/** A file action on body/data replaces the whole report input, never just its Monaco copy. */
	private async reloadInput(entry: string): Promise<void> {
		if (this.bodyLocks.has(entry)) throw new Error('正文操作正在进行，请稍后重新载入。')
		const token = this.documents.get(entry)?.inputToken
		clearTimeout(this.timers.get(`input:${entry}`))
		clearTimeout(this.timers.get(`compile:${entry}`))
		await this.inputSaves.get(entry)
		const current = this.documents.get(entry)
		if (this.closed || !current) return
		if (this.bodyLocks.has(entry) || current.inputToken !== token)
			throw new Error('重新载入期间报表草稿已改变；新修改已保留，请重新确认。')
		const saved = await api.getInput({ projectId: this.project.id, entry })
		const latest = this.documents.get(entry)
		if (this.closed || !latest) return
		if (
			this.bodyLocks.has(entry) ||
			latest.inputToken !== current.inputToken ||
			latest.storageVersion !== current.storageVersion
		)
			throw new Error('重新载入期间报表草稿已改变；新修改已保留，请重新确认。')
		await this.acceptSavedInput(entry, saved)
	}

	private async acceptSavedInput(entry: string, saved: DocumentInput): Promise<void> {
		const current = this.documents.get(entry)!
		clearTimeout(this.timers.get(`input:${entry}`))
		clearTimeout(this.timers.get(`compile:${entry}`))
		++this.navigationSerial
		if (this.bodyLocation?.entry === entry) this.bodyLocation = undefined
		this.replaceSourceProject(entry, saved, saved.editor?.files)
		this.documents.set(entry, {
			...current,
			...structuredClone(saved),
			editor: saved.editor && structuredClone(saved.editor),
			inputConflict: undefined,
			inputError: undefined,
			inputDirty: false,
			inputToken: (current.inputToken ?? 0) + 1,
			inputEpoch: (current.inputEpoch ?? 0) + 1,
			generation: ++this.documentGeneration,
			result: undefined,
			preview: undefined,
			error: undefined,
			diagnostics: [],
			busy: false,
		})
		this.emit()
		await this.compile(entry)
	}

	private async persistInput(entry: string, expectedVersion: string | null): Promise<void> {
		const current = this.documents.get(entry)!
		const token = current.inputToken
		this.documents.set(entry, { ...current, inputSaving: true, inputError: undefined })
		this.emit()
		const work = (async () => {
			try {
				let saved: DocumentInput
				try {
					saved = await api.setInput({
						projectId: this.project.id,
						entry,
						data: current.data,
						editor: current.editor,
						expectedVersion,
					})
				} catch (cause) {
					let readBack: DocumentInput | undefined
					try {
						readBack = await api.getInput({ projectId: this.project.id, entry })
					} catch {
						// The original failure remains actionable when read-back is also unavailable.
					}
					if (readBack?.storageVersion != null && inputContent(readBack) === inputContent(current))
						saved = readBack
					else {
						const next = this.documents.get(entry)!
						this.documents.set(entry, {
							...next,
							inputSaving: false,
							inputError: String(cause),
							...(readBack && readBack.storageVersion !== expectedVersion
								? { inputConflict: structuredClone(readBack) }
								: {}),
						})
						return
					}
				}
				const next = this.documents.get(entry)!
				this.documents.set(entry, {
					...next,
					...(next.inputToken === token ? { editor: saved.editor, data: saved.data } : {}),
					inputSaving: false,
					inputDirty: next.inputToken !== token,
					storageVersion: saved.storageVersion,
					assets: saved.assets,
					inputConflict: undefined,
					inputError: undefined,
				})
				this.replaceSourceProject(entry, this.documents.get(entry)!, saved.editor?.files)
			} finally {
				this.inputSaves.delete(entry)
				this.emit()
			}
		})()
		this.inputSaves.set(entry, work)
		await work
		this.releaseUnusedDocument(entry)
	}
}
class WorkspaceBodyParticipant extends RpcTarget implements BodyEditorParticipant {
	constructor(private readonly workspace: WorkspaceController) {
		super()
	}
	capture(input: Parameters<BodyEditorParticipant['capture']>[0]) {
		return this.workspace.captureBody(input)
	}
	finish(input: Parameters<BodyEditorParticipant['finish']>[0]) {
		return this.workspace.finishBody(input)
	}
}

export function useWorkspaceState(workspace: WorkspaceController) {
	useSyncExternalStore(workspace.subscribe, workspace.snapshot)
	return workspace
}

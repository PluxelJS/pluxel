import { useSyncExternalStore } from 'react'
import type { JSONContent } from '@tiptap/core'
import type { SourcePosition, TypstNavigationPoint } from '@pluxel/plugin-typst/browser'
import {
	validateTypstRegions,
	findTypstRegionPosition,
	findTypstGeneratedPosition,
} from '@pluxel/plugin-typst/tiptap'
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
} from '../shared/contracts'
import { studioEditorConfig } from '../shared/editor'
import { api, onDesktopConnectionChange } from './api'
import { isPaneVisible } from './source-navigation'

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
	entry: string
	result?: CompileResult
	preview?: PreviewResult
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
}

function inputContent({ data, editor }: Pick<DocumentInput, 'data' | 'editor'>): string {
	return JSON.stringify({ data, editor }, (_key, value: unknown) =>
		value && typeof value === 'object' && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: value,
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
	regionLocation?: {
		entry: string
		regionId: string
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
		this.disconnectListener = onDesktopConnectionChange((connected) => {
			// Retain visible pages and drafts, but never export or navigate an old generation.
			for (const [entry, document] of this.documents) {
				this.documents.set(entry, {
					...document,
					result: undefined,
					busy: false,
					generation: ++this.documentGeneration,
					error: !connected ? '后端连接已中断，等待恢复。' : '后端已更新，正在恢复当前草稿的预览。',
				})
			}
			this.emit()
			if (connected) for (const entry of this.documentUsers.keys()) void this.compile(entry)
		})
		void this.refresh()
		this.polling = setInterval(() => {
			void this.refresh()
		}, 1500)
	}
	dispose() {
		this.closed = true
		this.disconnectListener?.()
		clearInterval(this.polling)
		for (const timer of this.timers.values()) clearTimeout(timer)
		this.listeners.clear()
		this.previews.clear()
		this.documentUsers.clear()
		this.assistantState.drafts.clear()
		this.assistantState.activeThreadId = null
		this.openSource = undefined
		++this.navigationSerial
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
	revealRegion(entry: string, regionId: string, position: number) {
		const result = this.documents.get(entry)?.preview
		if (!result || !this.isNavigationCurrent(result)) return
		const source = findTypstGeneratedPosition({
			mapping: result.generatedMapping ?? [],
			navigation: result.preview.navigation,
			regionId,
			position,
			snapshotRevision: result.clientRevision,
		})
		if (source) {
			this.preferredPreview = entry
			this.revealPreview(source)
		}
	}
	async revealSource(result: PreviewResult, point: TypstNavigationPoint) {
		if (!this.isNavigationCurrent(result) || !point.path.endsWith('.typ')) return
		const serial = ++this.navigationSerial
		this.preferredPreview = result.entry
		if (point.path.startsWith('_editor/')) {
			const mapping = findTypstRegionPosition({
				mapping: result.generatedMapping ?? [],
				position: point,
				snapshotRevision: result.clientRevision,
			})
			if (mapping) {
				this.regionLocation = {
					entry: result.entry,
					...mapping,
					serial,
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
	/** False means the tree was not refreshed; dependent filesystem operations must stop. */
	async refresh(): Promise<boolean> {
		if (this.closed) return false
		if (this.refreshing) return this.refreshing
		this.refreshing = (async () => {
			try {
				const tree = await api.getTree({ projectId: this.project.id })
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
							this.files.set(entry.path, {
								...next,
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
				for (const entry of this.documentUsers.keys()) void this.compile(entry)
				return true
			} catch (cause) {
				this.error = cause instanceof Error ? cause.message : String(cause)
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
	/** Candidate identity includes unsaved source/resource edits as well as data and regions. */
	draftRevision(entry: string): string {
		return JSON.stringify([
			this.documents.get(entry)?.inputToken ?? 0,
			this.documents.get(entry)?.description?.sourceRevision,
			this.tree?.revision,
			[...this.files]
				.filter(([, file]) => file.dirty || file.missing)
				.map(([path, file]) => [path, file.token, file.missing]),
		])
	}
	edit(path: string, content: string) {
		const current = this.files.get(path)
		if (!current || current.missing) return
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
				await this.refresh()
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
	}
	/** Explicitly discard this resource's shared draft, including an externally removed file. */
	async discard(path: string) {
		clearTimeout(this.timers.get(path))
		await this.saves.get(path)
		const file = this.files.get(path)
		if (!file?.dirty || this.closed) return
		if (!file.missing) return this.reload(path)
		this.files.set(path, { ...file, content: file.saved, dirty: false, token: file.token + 1 })
		this.emit()
	}
	async reload(path: string) {
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
		if (this.documentUsers.has(entry) || document?.inputDirty || document?.inputSaving) return
		if (this.documents.delete(entry)) this.emit()
	}
	isDirty() {
		return (
			[...this.files.values()].some((file) => file.dirty) ||
			[...this.documents.values()].some((document) => document.inputDirty)
		)
	}
	/** One in-flight compilation and one latest pending snapshot per document. */
	async compile(entry: string): Promise<void> {
		if (this.closed || !this.documents.has(entry)) return
		const pending = this.compiles.get(entry)
		if (pending) {
			this.compilePending.add(entry)
			return pending
		}
		const work = (async () => {
			do {
				this.compilePending.delete(entry)
				await this.compileSnapshot(entry)
			} while (!this.closed && this.documents.has(entry) && this.compilePending.has(entry))
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
			this.documents.set(entry, {
				...current,
				fields: description.fields,
				description,
				inputToken: (current.inputToken ?? 0) + (templateChanged ? 1 : 0),
			})
			this.emit()
			if (!current.inputLoaded) {
				const stored = await api.getInput(target)
				if (this.closed || this.documents.get(entry)?.generation !== generation) return
				current = this.documents.get(entry)!
				// Defaults are explicit template-authored initial content, used only for a new draft.
				const editor =
					stored.editor ??
					(stored.storageVersion === null && description.editor
						? {
								formatVersion: 1 as const,
								templateId: description.editor.templateId,
								templateRevision: description.editor.templateRevision,
								regions: structuredClone(description.editor.defaults),
							}
						: undefined)
				this.documents.set(entry, {
					...current,
					data: current.inputDirty
						? current.data
						: stored.storageVersion === null
							? structuredClone(description.defaults)
							: stored.data,
					editor,
					storageVersion: stored.storageVersion,
					inputLoaded: true,
				})
				this.emit()
				// An edit made while the initial read was pending keeps its content, but only
				// saves after the authoritative storage version and existing regions are known.
				if (current.inputDirty) this.changedInput(entry)
			}
			current = this.documents.get(entry)!
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
	async writeRegion(entry: string, regionId: string, content: JSONContent) {
		const current = this.documents.get(entry)
		if (!current?.editor || !Object.hasOwn(current.editor.regions, regionId)) return
		this.documents.set(entry, {
			...current,
			// ProseMirror emits null-prototype attrs. Snapshot JSON data into transport-compatible
			// ordinary objects without dropping values or changing the native document shape.
			editor: {
				...current.editor,
				regions: { ...current.editor.regions, [regionId]: structuredClone(content) },
			},
			inputDirty: true,
			inputError: undefined,
			inputToken: (current.inputToken ?? 0) + 1,
		})
		this.changedInput(entry)
	}
	/** Adding a sidecar to an existing report never replaces its saved raw data. */
	initializeEditorDraft(entry: string) {
		const current = this.documents.get(entry)
		const description = current?.description?.editor
		if (!current?.inputLoaded || current.editor || !description) return
		this.documents.set(entry, {
			...current,
			editor: {
				formatVersion: 1,
				templateId: description.templateId,
				templateRevision: description.templateRevision,
				regions: structuredClone(description.defaults),
			},
			inputToken: (current.inputToken ?? 0) + 1,
			inputDirty: true,
			inputError: undefined,
		})
		this.changedInput(entry)
	}

	/** Explicit author-approved template adoption; invalid content stays in the old draft. */
	async adoptEditorTemplate(entry: string) {
		const current = this.documents.get(entry)
		const description = current?.description?.editor
		if (!current?.editor || !description) return
		const checked = validateTypstRegions({
			regions: current.editor.regions,
			config: studioEditorConfig(description),
		})
		if (!checked.ok) {
			this.documents.set(entry, {
				...current,
				inputError: checked.issues.map((issue) => issue.message).join('\n'),
			})
			this.emit()
			return
		}
		this.documents.set(entry, {
			...current,
			editor: {
				...current.editor,
				templateId: description.templateId,
				templateRevision: description.templateRevision,
			},
			inputToken: (current.inputToken ?? 0) + 1,
			inputDirty: true,
			inputError: undefined,
		})
		this.changedInput(entry)
	}

	async writeData(entry: string, data: JsonObject) {
		const current = this.documents.get(entry)
		if (!current) return
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
		if (!current || !saved || current.inputSaving) return
		if (choice === 'local') {
			// Explicit replacement still uses CAS. A further writer requires a fresh decision.
			return this.persistInput(entry, saved.storageVersion)
		}
		clearTimeout(this.timers.get(`input:${entry}`))
		clearTimeout(this.timers.get(`compile:${entry}`))
		++this.navigationSerial
		if (this.regionLocation?.entry === entry) this.regionLocation = undefined
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
					inputSaving: false,
					inputDirty: next.inputToken !== token,
					storageVersion: saved.storageVersion,
					inputConflict: undefined,
					inputError: undefined,
				})
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
export function useWorkspaceState(workspace: WorkspaceController) {
	useSyncExternalStore(workspace.subscribe, workspace.snapshot)
	return workspace
}

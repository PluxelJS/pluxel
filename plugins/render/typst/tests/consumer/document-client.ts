import type { JSONContent } from '@tiptap/core'
import type { DocumentFailure, DocumentRequest, DocumentView } from './document-contract'

export interface DocumentClientState {
	view?: DocumentView
	drafts: Readonly<Record<string, JSONContent>>
	busy: boolean
	message: string
	error: boolean
}

class RequestFailure extends Error {}

/** A business host's serialized save lane. It never owns or receives source files. */
export class DocumentClient {
	private readonly lease = crypto.randomUUID()
	private readonly documentId: string
	private state: DocumentClientState = { drafts: {}, busy: false, message: '', error: false }
	private readonly listeners = new Set<() => void>()
	private readonly pending = new Map<string, { document: JSONContent; version: number }>()
	private version = 0
	private stateVersion = 0
	private queued = 0
	private tail: Promise<unknown> = Promise.resolve()
	private timer?: ReturnType<typeof setTimeout>
	private closed = false

	constructor() {
		const stored = localStorage.getItem('pluxel-document-demo-id')
		this.documentId = stored && /^[0-9a-f-]{36}$/.test(stored) ? stored : crypto.randomUUID()
		localStorage.setItem('pluxel-document-demo-id', this.documentId)
	}

	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	getSnapshot = () => this.state

	private update(patch: Partial<DocumentClientState>) {
		this.stateVersion++
		this.state = { ...this.state, ...patch }
		for (const listener of this.listeners) listener()
	}

	private drafts() {
		return Object.fromEntries([...this.pending].map(([id, draft]) => [id, draft.document]))
	}

	private async request(request: DocumentRequest): Promise<DocumentView | Blob | undefined> {
		const response = await fetch('/document-api/session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Document-Client': this.lease },
			body: JSON.stringify(request),
		})
		if (!response.ok) {
			const failure = (await response.json()) as DocumentFailure
			throw new RequestFailure(failure.message)
		}
		if (response.status === 204) return
		if (request.action === 'pdf') return response.blob()
		return response.json() as Promise<DocumentView>
	}

	private run<T>(task: () => Promise<T>): Promise<T> {
		this.queued++
		this.update({ busy: true })
		const result = this.tail.then(task)
		this.tail = result.catch(() => {})
		return result
			.catch((error: unknown) => {
				this.update({
					error: true,
					message:
						error instanceof RequestFailure
							? error.message
							: '连接未完成，当前输入仍保留，请重试。',
				})
				throw error
			})
			.finally(() => {
				this.queued--
				this.update({ busy: this.queued > 0 })
			})
	}

	private accept(view: DocumentView) {
		this.update({ view, drafts: this.drafts(), message: '', error: false })
	}

	private requireConfirmedInput() {
		const pending = [...document.querySelectorAll('.document-chapter')].some(
			(panel) =>
				panel.querySelector('[data-typst-unapplied]') ||
				[...panel.querySelectorAll('[aria-controls]')].some((anchor) =>
					document
						.getElementById(anchor.getAttribute('aria-controls')!)
						?.querySelector('[data-typst-unapplied]'),
				),
		)
		if (pending) throw new RequestFailure('有尚未确认的输入，请先应用或取消。')
	}

	discardDrafts() {
		if (this.state.busy) return
		clearTimeout(this.timer)
		this.pending.clear()
		this.update({ drafts: {}, error: false, message: '已恢复为上次同步的内容。' })
	}

	open() {
		return this.run(async () => {
			this.accept(
				(await this.request({ action: 'open', documentId: this.documentId })) as DocumentView,
			)
		})
	}

	edit(chapterId: string, document: JSONContent) {
		this.pending.set(chapterId, { document, version: ++this.version })
		this.update({ drafts: this.drafts() })
		clearTimeout(this.timer)
		this.timer = setTimeout(() => {
			void this.synchronize().catch(() => {})
		}, 400)
	}

	private async flush() {
		clearTimeout(this.timer)
		while (this.pending.size > 0) {
			const [chapterId, draft] = this.pending.entries().next().value!
			const view = (await this.request({
				action: 'edit',
				baseRevision: this.state.view!.revision,
				chapterId,
				document: draft.document,
			})) as DocumentView
			if (this.pending.get(chapterId)?.version === draft.version) this.pending.delete(chapterId)
			this.accept(view)
		}
	}

	synchronize() {
		return this.run(() => this.flush())
	}

	perform(
		operation:
			| { action: 'undo' | 'redo' | 'save' }
			| { action: 'rename'; chapterId: string; title: string }
			| { action: 'reorder'; chapterIds: string[] }
			| { action: 'create'; chapterId: string; title: string },
	) {
		return this.run(async () => {
			this.requireConfirmedInput()
			await this.flush()
			this.accept(
				(await this.request({
					...operation,
					baseRevision: this.state.view!.revision,
				})) as DocumentView,
			)
			if (operation.action === 'save') this.update({ message: '已保存', error: false })
		})
	}

	exportPdf() {
		return this.run(async () => {
			this.requireConfirmedInput()
			await this.flush()
			const data = (await this.request({
				action: 'pdf',
				revision: this.state.view!.revision,
			})) as Blob
			const url = URL.createObjectURL(data)
			const anchor = document.createElement('a')
			anchor.href = url
			anchor.download = '项目书.pdf'
			anchor.click()
			URL.revokeObjectURL(url)
		})
	}

	get leaveToken() {
		return this.stateVersion
	}

	get unsaved() {
		return this.pending.size > 0 || Boolean(this.state.view?.dirty)
	}

	close = () => {
		if (this.closed) return
		this.closed = true
		clearTimeout(this.timer)
		if (!this.state.view && this.queued === 0) return
		void fetch('/document-api/session', {
			method: 'POST',
			keepalive: true,
			headers: { 'Content-Type': 'application/json', 'X-Document-Client': this.lease },
			body: JSON.stringify({ action: 'close' }),
		}).catch(() => {})
	}
}

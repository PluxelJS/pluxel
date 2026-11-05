import { type AnyRouter } from '@tanstack/react-router'
import {
	createContext,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
	useRef,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import { type PluginNodeAddress } from '@pluxel/core'
import {
	useContent,
	useContentController,
	useWorkbenchState,
	type ContentHandle,
	type LeaveState,
	type LeaveRequest,
	type LeaveDecision,
} from '@worksplit/react'
import { openConfirmModal, closeModal } from '@mantine/modals'
import { useWorkspaceSession, useOptionalWorkspaceSession } from './workspaceContext'

/** Editing facts stay in the form/remote owner; the persistent document binds one controller. */
export interface DocumentEditor {
	getState(): LeaveState
	isWritePending(): boolean
	save?(): void | Promise<void>
}
export class WorkbenchDocumentState {
	navigate?: AnyRouter['navigate']
	workspace?: 'plugins' | 'apps'
	plugin?: PluginNodeAddress
	pluginEntry?: string
	title?: string
	remoteTitle?: { owner: object; value: string }
	private currentEditor?: DocumentEditor
	private ownerRevision = 0
	private remoteRevision = 0
	private dirty = false
	set editor(value: DocumentEditor | undefined) {
		if (value !== this.currentEditor) this.ownerRevision++
		this.currentEditor = value
	}
	get editor() {
		return this.currentEditor
	}
	set remoteDirty(value: boolean) {
		this.dirty = value
		this.remoteRevision++
	}
	get remoteDirty() {
		return this.dirty
	}
	getState = (): LeaveState => ({
		hasUnsavedChanges: this.isDirty(),
		token: JSON.stringify([this.ownerRevision, this.remoteRevision, this.editor?.getState().token]),
	})
	isDirty = () => this.remoteDirty || Boolean(this.editor?.getState().hasUnsavedChanges)
	blocksUnload = () => this.isDirty() || Boolean(this.editor?.isWritePending())

	async decide(request: LeaveRequest): Promise<LeaveDecision> {
		// Search/hash state belongs to the same editable resource.
		if (
			request.reason === 'navigate' &&
			request.from.pathname === request.to.pathname &&
			new URLSearchParams(request.from.searchStr).get('entry') ===
				new URLSearchParams(request.to.searchStr).get('entry')
		)
			return { decision: 'allow', token: this.getState().token }
		if (this.editor?.isWritePending()) return { decision: 'deny', reason: '配置写入尚未确认' }
		const editor = this.editor
		const token = request.state.token
		if (this.isDirty()) {
			const choice = await new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
				if (request.signal.aborted) {
					resolve('cancel')
					return
				}
				let settled = false
				let modal: string | undefined
				const finish = (answer: 'save' | 'discard' | 'cancel') => {
					if (settled) return
					settled = true
					request.signal.removeEventListener('abort', cancel)
					if (modal) closeModal(modal)
					resolve(answer)
				}
				const cancel = () => finish('cancel')
				request.signal.addEventListener('abort', cancel, { once: true })
				modal = openConfirmModal({
					title: '此文档有未保存的更改',
					returnFocus: false,
					children: editor?.save
						? '保存成功后继续，或取消并保留输入。'
						: '继续会放弃此文档的未保存更改。',
					labels: { confirm: editor?.save ? '保存并继续' : '放弃更改并继续', cancel: '保留文档' },
					onConfirm: () => finish(editor?.save ? 'save' : 'discard'),
					onCancel: cancel,
					onClose: cancel,
				})
			})
			if (
				choice === 'cancel' ||
				request.signal.aborted ||
				this.editor !== editor ||
				this.getState().token !== token
			)
				return { decision: 'deny' }
			if (choice === 'save') {
				await editor?.save?.()
				if (this.editor !== editor || this.blocksUnload()) return { decision: 'deny' }
			}
		}
		return { decision: 'allow', token: this.getState().token }
	}
}
const DocumentContext = createContext<{
	id: string
	state: WorkbenchDocumentState
	content: ContentHandle
} | null>(null)
export function useOptionalWorkbenchDocument() {
	return useContext(DocumentContext)
}

export function WorkbenchDocumentRoot({ children }: { children: ReactNode }) {
	const session = useWorkspaceSession()
	const [state] = useState(() => new WorkbenchDocumentState())
	const content = useContent()
	const root = useRef<HTMLDivElement>(null)
	const pauses = useRef(0)
	useSyncExternalStore(session.subscribeContentState, session.getContentRevision)
	const href = useWorkbenchState(
		session.workbench,
		() => session.workbench.getDocument(content.id)?.href,
	)
	const openingTitle = useWorkbenchState(session.workbench, () => {
		const document = session.workbench.getDocument(content.id)
		const title: unknown = document?.node.getConfig()?.pluxelTitle
		if (title === undefined) return undefined
		if (
			!title ||
			typeof title !== 'object' ||
			!('href' in title) ||
			typeof title.href !== 'string' ||
			!('value' in title) ||
			typeof title.value !== 'string'
		)
			throw new Error('文档标题配置无效')
		return title.href === document?.href ? title.value : undefined
	})
	useContentController({
		title:
			state.remoteTitle?.value ??
			state.title ??
			openingTitle ??
			(href ? session.resolveTitle?.(href) : undefined),
		leave:
			state.editor || state.remoteDirty
				? {
						getState: state.getState,
						decide: async (request) => {
							const decision = await state.decide(request)
							if (decision.decision === 'allow' && !request.signal.aborted) {
								// Keep the accepted old page inert until the native Router settles, including loaders.
								pauses.current++
								if (root.current) root.current.inert = true
								request.defer(() => {
									pauses.current--
									if (root.current) root.current.inert = pauses.current > 0
								})
							}
							return decision
						},
					}
				: null,
		save: () => state.editor?.save?.(),
		focus: () =>
			root.current
				?.querySelector<HTMLElement>(
					'input:not(:disabled), textarea:not(:disabled), [contenteditable="true"]',
				)
				?.focus(),
	})
	useEffect(() => {
		session.documents.set(content.id, state)
		session.notifyContentState()
		return () => {
			session.documents.delete(content.id)
			session.notifyContentState()
		}
	}, [content.id, session, state])
	const value = useMemo(() => ({ id: content.id, state, content }), [content, state])
	return (
		<DocumentContext.Provider value={value}>
			<div ref={root} style={{ height: '100%', minHeight: 0 }}>
				{children}
			</div>
		</DocumentContext.Provider>
	)
}

/** Built-in catalogs can own a workspace before an individual plugin is selected or loaded. */
export function useDocumentWorkspace(workspace: 'plugins' | 'apps') {
	const document = useOptionalWorkbenchDocument()
	const session = useOptionalWorkspaceSession()
	useLayoutEffect(() => {
		if (!document || !session) return
		const previous = document.state.workspace
		document.state.workspace = workspace
		session.notifyContentState()
		return () => {
			if (document.state.workspace === workspace) document.state.workspace = previous
			session.notifyContentState()
		}
	}, [document, workspace, session])
}

/** The rendered route supplies its canonical owner; tools follow the active document. */
export function useDocumentPlugin(owner: PluginNodeAddress | undefined, entry?: string) {
	const document = useOptionalWorkbenchDocument()
	const session = useOptionalWorkspaceSession()
	useLayoutEffect(() => {
		if (!document || !owner || !session) return
		const previous = document.state.plugin
		const previousEntry = document.state.pluginEntry
		document.state.plugin = owner
		document.state.pluginEntry = entry
		session.notifyContentState()
		return () => {
			if (document.state.plugin === owner && document.state.pluginEntry === entry) {
				document.state.plugin = previous
				document.state.pluginEntry = previousEntry
			}
			session.notifyContentState()
		}
	}, [document, owner, entry, session])
}

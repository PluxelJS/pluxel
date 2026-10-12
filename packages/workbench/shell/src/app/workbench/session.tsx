import {
	createWorkbench,
	type StartResult,
	type NavigationResult,
	type CloseResult,
} from '@worksplit/react'
import { Actions, type IJsonModel } from 'flexlayout-react'
import { openConfirmModal } from '@mantine/modals'
import { createAppRouter, readWorkbenchUiBasePath } from '../router'
import { WorkbenchDocumentRoot, type WorkbenchDocumentState } from './document'
import { WorkspaceNavigation } from './WorkspaceNavigation'
import { notifyAndRecord } from '../notifications/notifyBridge'
import { WorkspaceSnapshotStorage, WorkspaceRestoreError, workspaceStorageKey } from './snapshot'

export const navigationTab = {
	type: 'tab' as const,
	id: 'navigation',
	name: '入口',
	component: 'worksplit.tool',
	enableClose: true,
}
export function defaultWorkspaceLayout(): IJsonModel {
	return {
		global: {
			tabEnableFloat: false,
			tabEnablePopout: false,
			tabEnablePin: true,
			tabEnableRename: true,
			tabSetEnableTabGroups: true,
			tabSetMinWidth: 160,
			tabSetMinHeight: 100,
			tabSetEnableDeleteWhenEmpty: true,
		},
		borders: [
			{
				type: 'border',
				location: 'left',
				size: 260,
				selected: 0,
				children: [{ ...navigationTab }],
			},
		],
		layout: { type: 'row', children: [{ type: 'tabset', id: 'main', children: [] }] },
	}
}

/** The authenticated page owns this session. React Shell borrows it; effect replay retains it. */
export class WorkspaceSession {
	readonly workbench
	readonly documents = new Map<string, WorkbenchDocumentState>()
	readonly basepath: string
	readonly storage: WorkspaceSnapshotStorage
	private readonly contentListeners = new Set<() => void>()
	private contentRevision = 0
	subscribeContentState = (listener: () => void) => {
		this.contentListeners.add(listener)
		return () => {
			this.contentListeners.delete(listener)
		}
	}
	getContentRevision = () => this.contentRevision
	notifyContentState = () => {
		this.contentRevision++
		for (const listener of this.contentListeners) listener()
	}
	private started?: Promise<StartResult>
	private disconnect?: () => void
	private disposing?: Promise<void>

	constructor(
		options: { basepath?: string; snapshot?: unknown; storage?: WorkspaceSnapshotStorage } = {},
	) {
		this.basepath = options.basepath ?? readWorkbenchUiBasePath()
		this.storage =
			options.storage ?? new WorkspaceSnapshotStorage(workspaceStorageKey(this.basepath))
		const snapshot = options.snapshot !== undefined ? options.snapshot : this.storage.readSnapshot()
		try {
			this.workbench = createWorkbench({
				workspaceId: `pluxel:${this.basepath}`,
				home: this.basepath,
				createRouter: (history) =>
					createAppRouter({ history, uiBasePath: this.basepath, Wrap: WorkbenchDocumentRoot }),
				layout: defaultWorkspaceLayout(),
				snapshot,
				tools: [{ id: 'navigation', render: () => <WorkspaceNavigation /> }],
				onIssue: ({ code, error }) => {
					if (code === 'history-outside-scope') {
						void this.leave(location.href).catch((cause: unknown) => this.report(cause))
						return
					}
					this.report(new Error(`${code}: ${String(error)}`, { cause: error }))
				},
			})
		} catch (cause) {
			if (snapshot !== undefined) throw new WorkspaceRestoreError(this.storage, cause)
			throw cause
		}
	}
	start(
		href = location.pathname + location.search + location.hash,
		browser = true,
	): Promise<StartResult> {
		return (this.started ??= (async () => {
			if (browser) this.disconnect = this.workbench.connectBrowser()
			this.storage.connect(() => this.workbench.snapshot())
			window.addEventListener('beforeunload', this.beforeUnload)
			const result = await this.workbench.start(href)
			this.check(result)
			return result
		})())
	}
	check(result: NavigationResult | CloseResult | { status: 'empty' | 'applied' | 'rejected' }) {
		if (result.status === 'failed') this.report(result.error)
		else if (result.status === 'rejected')
			this.report(
				new Error(`操作未完成：${'reason' in result ? result.reason : '目标不允许此操作'}`),
			)
		else if (result.status === 'superseded')
			this.report(new Error('操作目标已改变，请重新选择目标'))
		else if (result.status === 'closed' && result.cleanupErrors.length > 0)
			this.report(new AggregateError(result.cleanupErrors, '标签已关闭，但资源释放失败'))
	}
	report(error: unknown) {
		notifyAndRecord({
			title: '工作区',
			message: error instanceof Error ? error.message : String(error),
			color: 'red',
		})
	}
	async leave(href: string): Promise<void> {
		const restoreAcceptedLocation = () => {
			const active = this.workbench.getActiveDocument()
			// Preserve the live draft when an outside entry is refused. The foreign
			// history state remains foreign; no Worksplit scope or index is invented.
			if (active && location.pathname + location.search + location.hash !== active.href)
				history.replaceState(history.state, '', active.href)
		}
		try {
			const owners = [...this.documents.entries()]
			const approvals = []
			for (const [id, state] of owners) {
				if (!(await state.beforeLeave())) {
					restoreAcceptedLocation()
					return
				}
				approvals.push({
					id,
					state,
					editor: state.editor,
					dirty: state.isDirty(),
					revision: state.editor?.getCloseRevision?.(),
					hasRevision: Boolean(state.editor?.getCloseRevision),
				})
			}
			// A later confirmation can wait while an already approved editor changes.
			// Recheck its actual editing facts before replacing the whole document.
			if (
				this.documents.size !== owners.length ||
				approvals.some(
					({ id, state, editor, dirty, revision, hasRevision }) =>
						this.documents.get(id) !== state ||
						state.editor !== editor ||
						(state.isDirty() &&
							(!dirty ||
								hasRevision !== Boolean(editor?.getCloseRevision) ||
								(hasRevision && revision !== editor?.getCloseRevision?.()))),
				)
			)
				throw new Error('退出期间文档或未保存的输入已改变，请重新检查后继续。')
		} catch (cause) {
			restoreAcceptedLocation()
			throw cause
		}
		location.assign(href)
	}
	private beforeUnload = (event: BeforeUnloadEvent) => {
		if (![...this.documents.values()].some((document) => document.isDirty())) return
		event.preventDefault()
		event.returnValue = ''
	}
	async closeDocuments(): Promise<boolean> {
		const documents = this.workbench.getDocuments()
		const layout = this.workbench.getLayout()
		const protectedIds = new Set<string>()
		const visit = (node: {
			id?: string
			type?: string
			pinned?: boolean
			enableClose?: boolean
			children?: unknown[]
		}) => {
			if (
				node.type === 'tab' &&
				node.id &&
				(node.pinned || (node.enableClose ?? layout.global?.tabEnableClose) === false)
			)
				protectedIds.add(node.id)
			for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0])
		}
		visit(layout.layout)
		for (const border of layout.borders ?? []) visit(border)
		const protectedDocuments = documents.filter((document) => protectedIds.has(document.id))
		if (protectedDocuments.length > 0) {
			this.report(
				new Error(
					`请先解除固定或关闭保护：${protectedDocuments.map((document) => document.title).join('、')}`,
				),
			)
			return false
		}
		if (documents.length === 0) return true
		const result = await this.workbench.dispatch(
			Actions.group(documents.map((document) => Actions.deleteTab(document.id))),
		)
		if (result.status === 'failed') this.report(result.error)
		if (result.status === 'rejected')
			this.report(new Error(`内容未关闭：${'reason' in result ? result.reason : '操作被拒绝'}`))
		if (result.status !== 'closed') return false
		if (result.cleanupErrors.length > 0) {
			this.report(
				new AggregateError(result.cleanupErrors, '内容已关闭，但资源释放失败；暂不重建工作区'),
			)
			return false
		}
		return true
	}
	async resetLayout(): Promise<boolean> {
		const confirmed = await new Promise<boolean>((resolve) =>
			openConfirmModal({
				title: '恢复默认布局',
				children:
					'将关闭所有文档并重新载入工作区。固定或受保护标签须先解除保护；已保存的业务修改不会撤销。',
				labels: { confirm: '关闭文档并恢复布局', cancel: '保留工作区' },
				onConfirm: () => resolve(true),
				onCancel: () => resolve(false),
				onClose: () => resolve(false),
			}),
		)
		if (!confirmed || !(await this.closeDocuments())) return false
		if (
			!this.storage.write({
				version: 1,
				workspaceId: `pluxel:${this.basepath}`,
				layout: defaultWorkspaceLayout(),
			})
		)
			return false
		// Stop pending writes before a full page replacement; no unsupported Model replacement.
		this.storage.blocked = true
		location.assign(this.basepath)
		return true
	}
	dispose(): Promise<void> {
		return (this.disposing ??= (async () => {
			this.storage.close()
			window.removeEventListener('beforeunload', this.beforeUnload)
			this.disconnect?.()
			const errors = await this.workbench.dispose()
			if (errors.length > 0) this.report(new AggregateError(errors, '内容已关闭，资源释放失败'))
		})())
	}
}

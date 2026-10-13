import {
	createWorkbench,
	type StartResult,
	type NavigationResult,
	type CloseResult,
} from '@worksplit/react'
import {
	Actions,
	DockLocation,
	Model,
	TabNode,
	BorderNode,
	TabSetNode,
	TabGroupNode,
	RowNode,
	Orientation,
	type Node,
	type IJsonModel,
} from 'flexlayout-react'
import { openConfirmModal } from '@mantine/modals'
import { createAppRouter, readWorkbenchUiBasePath } from '../router'
import { WorkbenchDocumentRoot, type WorkbenchDocumentState } from './document'
import { PluginTool } from './PluginTools'
import { PluginNavigation } from './PluginNavigation'
import { notifyAndRecord } from '../notifications/notifyBridge'
import { WorkspaceSnapshotStorage, WorkspaceRestoreError, workspaceStorageKey } from './snapshot'

export const navigationTab = {
	type: 'tab' as const,
	id: 'navigation',
	name: '插件目录',
	component: 'worksplit.tool',
	enableClose: true,
}
export const pluginInspectorTab = { ...navigationTab, id: 'plugin-inspector', name: '插件面板' }
export const pluginLogsTab = { ...navigationTab, id: 'plugin-logs', name: '插件工具' }
type LogReturnLocation = {
	containerId: string
	groupId?: string
	index: number
	anchorIds?: string[]
	anchorId?: string
	side?: 'left' | 'right' | 'top' | 'bottom'
	weights?: Record<string, number>
}

function tabsetIds(node: Node): string[] {
	return node instanceof TabSetNode ? [node.getId()] : node.getChildren().flatMap(tabsetIds)
}

export function defaultWorkspaceLayout(compact = window.innerWidth <= 680): IJsonModel {
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
				show: false,
				size: 280,
				className: 'plx-navigation-border',
				config: { navigationMode: 'icons', navigationView: 'plugins', expanded: !compact },
				selected: 0,
				children: [{ ...navigationTab }],
			},
			{
				type: 'border',
				location: 'right',
				show: false,
				config: { expanded: false },
				size: 320,
				selected: 0,
				children: [{ ...pluginInspectorTab }],
			},
			{
				type: 'border',
				location: 'bottom',
				show: false,
				config: { expanded: false },
				enableAutoHide: true,
				selected: -1,
				children: [],
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
	private synchronizingPanels?: Promise<void>
	private panelsPending = false

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
				tools: [
					{ id: 'navigation', render: () => <PluginNavigation /> },
					{ id: 'plugin-inspector', render: () => <PluginTool kind="inspector" /> },
					{ id: 'plugin-logs', render: () => <PluginTool kind="logs" /> },
				],
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
	activeWorkspace(): 'plugins' | 'apps' | undefined {
		const active = this.workbench.getActiveDocument()
		const document = active ? this.documents.get(active.id) : undefined
		return document?.workspace ?? (document?.plugin ? 'apps' : undefined)
	}
	private panelExpanded(side: 'left' | 'right' | 'bottom'): boolean {
		return (
			this.workbench.getLayout().borders?.find((border) => border.location === side)?.config
				?.expanded === true
		)
	}
	private async setPanelExpanded(side: 'left' | 'right' | 'bottom', expanded: boolean) {
		const border = this.workbench
			.getLayout()
			.borders?.find((candidate) => candidate.location === side)
		if (!border || border.config?.expanded === expanded) return
		this.check(
			await this.workbench.dispatch(
				Actions.updateNodeAttributes(`border_${side}`, {
					config: { ...border.config, expanded },
				}),
			),
		)
	}
	/** Project document context onto auxiliary-only containers without replacing manual preferences. */
	private appLeftPanelsAvailable = false
	private appLeftPanelsOwner?: WorkbenchDocumentState['plugin']
	private hasAppLeftPanels(): boolean {
		const id = this.workbench.getActiveDocument()?.id
		return (
			this.appLeftPanelsAvailable &&
			!!id &&
			this.documents.get(id)?.plugin === this.appLeftPanelsOwner
		)
	}
	syncWorkspacePanels(appLeftPanelsAvailable = this.hasAppLeftPanels()): Promise<void> {
		this.appLeftPanelsAvailable = appLeftPanelsAvailable
		const activeId = this.workbench.getActiveDocument()?.id
		this.appLeftPanelsOwner = activeId ? this.documents.get(activeId)?.plugin : undefined
		this.panelsPending = true
		return (this.synchronizingPanels ??= Promise.resolve().then(async () => {
			try {
				while (this.panelsPending && !this.disposing) {
					this.panelsPending = false
					const plugins = !!this.activeWorkspace()
					const model = Model.fromJson(this.workbench.getLayout())
					const auxiliary = (node: Node): boolean =>
						node instanceof TabNode
							? [navigationTab.id, pluginInspectorTab.id, pluginLogsTab.id].includes(node.getId())
							: node.getChildren().every(auxiliary)
					for (const side of ['left', 'right'] as const) {
						const border = model.getNodeById(`border_${side}`)
						if (!(border instanceof BorderNode) || !auxiliary(border)) continue
						const available =
							side !== 'left' || this.activeWorkspace() === 'plugins' || this.hasAppLeftPanels()
						const show =
							plugins && available && this.panelExpanded(side) && border.getTabNodes().length > 0
						if (border.isShowing() !== show)
							this.check(
								await this.workbench.dispatch(
									Actions.updateNodeAttributes(border.getId(), { show }),
								),
							)
					}
					const log = model.getNodeById(pluginLogsTab.id)
					const logParent = log?.getParent()
					const logContainer = logParent instanceof TabGroupNode ? logParent.getParent() : logParent
					if (
						!plugins &&
						log instanceof TabNode &&
						logContainer &&
						auxiliary(logContainer) &&
						(logContainer.getId() !== 'border_bottom' || this.isToolVisible(log.getId()))
					)
						await this.toggleLogVisibility(true)
					else if (
						plugins &&
						this.panelExpanded('bottom') &&
						log instanceof TabNode &&
						logContainer?.getId() === 'border_bottom' &&
						!this.isToolVisible(log.getId())
					)
						await this.toggleLogVisibility()
				}
				return undefined
			} finally {
				this.synchronizingPanels = undefined
			}
		}))
	}
	navigationMode(): 'icons' | 'labels' {
		const config: unknown = this.workbench
			.getLayout()
			.borders?.find((border) => border.location === 'left')?.config
		return config &&
			typeof config === 'object' &&
			'navigationMode' in config &&
			config.navigationMode === 'labels'
			? 'labels'
			: 'icons'
	}
	async setNavigationMode(navigationMode: 'icons' | 'labels') {
		this.check(
			await this.workbench.dispatch(
				Actions.updateNodeAttributes('border_left', {
					config: { ...this.navigationConfig(), navigationMode },
				}),
			),
		)
	}
	private navigationConfig(): Record<string, unknown> {
		const config: unknown = this.workbench
			.getLayout()
			.borders?.find((border) => border.location === 'left')?.config
		return config && typeof config === 'object' ? (config as Record<string, unknown>) : {}
	}
	navigationView(): 'plugins' | `panel:${string}` {
		const view = this.navigationConfig().navigationView
		return typeof view === 'string' && view.startsWith('panel:')
			? (view as `panel:${string}`)
			: 'plugins'
	}
	async setNavigationView(navigationView: 'plugins' | `panel:${string}`) {
		this.check(
			await this.workbench.dispatch(
				Actions.updateNodeAttributes('border_left', {
					config: { ...this.navigationConfig(), navigationView },
				}),
			),
		)
	}
	isToolVisible(id: string): boolean {
		const model = Model.fromJson(this.workbench.getLayout())
		const node = model.getNodeById(id)
		if (!(node instanceof TabNode)) return false
		let parent = node.getParent()
		if (parent instanceof TabGroupNode) {
			if (!parent.isOpened()) return false
			parent = parent.getParent()
		}
		if (!(parent instanceof BorderNode || parent instanceof TabSetNode)) return false
		if (parent instanceof BorderNode && !parent.isShowing()) return false
		const maximized = model.getMaximizedTabset()
		if (parent instanceof TabSetNode && maximized && maximized !== parent) return false
		return parent.getSelectedNode()?.getId() === id
	}
	async toggleLogs() {
		if (!this.activeWorkspace()) return
		await this.setPanelExpanded('bottom', !this.isToolVisible(pluginLogsTab.id))
		await this.toggleLogVisibility()
	}
	private async toggleLogVisibility(hide = this.isToolVisible(pluginLogsTab.id)) {
		const activeDocument = this.workbench.getActiveDocument()
		let model = Model.fromJson(this.workbench.getLayout())
		const log = model.getNodeById(pluginLogsTab.id)
		if (hide) {
			if (!(log instanceof TabNode)) return
			const parent = log.getParent()!
			const container = parent instanceof TabGroupNode ? parent.getParent()! : parent
			const returnTo: LogReturnLocation = {
				containerId: container.getId(),
				groupId: parent instanceof TabGroupNode ? parent.getId() : undefined,
				index: parent.getChildren().indexOf(log),
			}
			const row = container?.getParent()
			if (container instanceof TabSetNode && row instanceof RowNode) {
				const siblings = row.getChildren()
				const index = siblings.indexOf(container)
				const anchor = siblings[index - 1] ?? siblings[index + 1]
				if (anchor) {
					returnTo.anchorId = anchor.getId()
					returnTo.anchorIds = tabsetIds(anchor)
					returnTo.side =
						row.getOrientation() === Orientation.HORZ
							? index > 0
								? 'right'
								: 'left'
							: index > 0
								? 'bottom'
								: 'top'
					returnTo.weights = Object.fromEntries(
						siblings.map((node) => [node.getId(), (node as RowNode | TabSetNode).getWeight()]),
					)
				}
			}
			const result = await this.workbench.dispatch(
				Actions.group([
					Actions.updateNodeAttributes(log.getId(), {
						config: { ...log.getConfig(), logReturnLocation: returnTo },
					}),
					...(parent.getId() === 'border_bottom'
						? []
						: [Actions.moveNode(log.getId(), 'border_bottom', DockLocation.CENTER, -1, true)]),
					Actions.updateNodeAttributes('border_bottom', { show: false }),
				]),
			)
			this.check(result)
			if (result.status === 'applied' && activeDocument) this.workbench.activate(activeDocument.id)
			return
		}
		const returnTo: LogReturnLocation | undefined =
			log instanceof TabNode ? log.getConfig()?.logReturnLocation : undefined
		if (log instanceof TabNode && log.getParent()?.getId() === 'border_bottom' && returnTo) {
			let target = returnTo.groupId ? model.getNodeById(returnTo.groupId) : undefined
			target ??= model.getNodeById(returnTo.containerId)
			let side = DockLocation.CENTER
			if (!target && returnTo.anchorIds?.length) {
				const anchors = returnTo.anchorIds
					.map((id) => model.getNodeById(id))
					.filter((node): node is Node => !!node)
				target = anchors[0]
				// Native tidy may absorb a sibling row. Its surviving tabsets identify the same region.
				while (
					target &&
					!anchors.every((anchor) => {
						let node: Node | undefined = anchor
						while (node && node !== target) node = node.getParent()
						return node === target
					})
				)
					target = target.getParent()
				side = DockLocation.values.get(returnTo.side ?? 'bottom') ?? DockLocation.BOTTOM
			}
			if (!target) {
				target = model.getRootRow()
				side = DockLocation.BOTTOM
			}
			if (!target) throw new Error('工作区缺少中心布局，请恢复默认布局。')
			const result = await this.workbench.dispatch(
				Actions.moveNode(log.getId(), target.getId(), side, returnTo.index, true),
			)
			this.check(result)
			if (result.status !== 'applied') return
			model = Model.fromJson(this.workbench.getLayout())
			let restored = model.getNodeById(log.getId())?.getParent()
			if (restored instanceof TabGroupNode) restored = restored.getParent()
			if (restored instanceof BorderNode) {
				this.check(
					await this.workbench.dispatch(
						Actions.updateNodeAttributes(restored.getId(), { show: true }),
					),
				)
			} else if (
				restored instanceof TabSetNode &&
				side !== DockLocation.CENTER &&
				returnTo.weights
			) {
				const row = restored.getParent()
				if (row instanceof RowNode) {
					const weights = row.getChildren().map((node) => {
						const originalId =
							node === restored
								? returnTo.containerId
								: returnTo.anchorId &&
									  tabsetIds(node).some((id) => returnTo.anchorIds?.includes(id))
									? returnTo.anchorId
									: node.getId()
						return returnTo.weights![originalId] ?? (node as RowNode | TabSetNode).getWeight()
					})
					this.check(await this.workbench.dispatch(Actions.adjustWeights(row.getId(), weights)))
				}
			}
			this.workbench.activate(log.getId())
			if (activeDocument && activeDocument.containerId !== restored?.getId())
				this.workbench.activate(activeDocument.id)
			return
		}
		if (this.workbench.activate(pluginLogsTab.id)) return
		const root = model.getRootRow()
		if (!root) throw new Error('工作区缺少中心布局，请恢复默认布局。')
		this.check(
			await this.workbench.dispatch(
				Actions.addTab({ ...pluginLogsTab }, root.getId(), DockLocation.BOTTOM, -1, true),
			),
		)
		if (activeDocument) this.workbench.activate(activeDocument.id)
	}

	async showTool(tab: typeof navigationTab) {
		await this.setPanelExpanded('left', true)
		if (!this.activeWorkspace()) return
		if (this.activeWorkspace() === 'apps' && !this.hasAppLeftPanels()) return
		if (this.workbench.activate(tab.id)) return
		const result = await this.workbench.dispatch(
			Actions.addTab({ ...tab }, 'border_left', DockLocation.CENTER, -1, true),
		)
		this.check(result)
		if (result.status === 'applied') this.workbench.activate(tab.id)
	}
	async toggleBorder(side: 'left' | 'right') {
		if (!this.activeWorkspace()) return
		if (side === 'left' && this.activeWorkspace() === 'apps' && !this.hasAppLeftPanels()) return
		const border = this.workbench.getLayout().borders?.find((item) => item.location === side)
		if (!border) {
			this.report(new Error('保存的布局不包含此侧栏，请从工作区菜单恢复默认布局。'))
			return
		}
		const id = `border_${side}`
		if (border.show !== false && (border.selected ?? -1) >= 0) {
			await this.setPanelExpanded(side, false)
			this.check(await this.workbench.dispatch(Actions.updateNodeAttributes(id, { show: false })))
			return
		}
		await this.setPanelExpanded(side, true)
		const tab = side === 'left' ? navigationTab : pluginInspectorTab
		const model = Model.fromJson(this.workbench.getLayout())
		if (!border.children?.length) {
			const node = model.getNodeById(tab.id)
			const result = await this.workbench.dispatch(
				node instanceof TabNode
					? Actions.moveNode(tab.id, id, DockLocation.CENTER, -1)
					: Actions.addTab({ ...tab }, id, DockLocation.CENTER, -1, true),
			)
			this.check(result)
			if (result.status !== 'applied') return
		}
		this.check(
			await this.workbench.dispatch(
				Actions.updateNodeAttributes(id, {
					show: true,
					selected: Math.max(0, border.selected ?? -1),
				}),
			),
		)
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

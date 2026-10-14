import { formatPluginNodeReference, parsePluginNodeReference } from '@pluxel/core'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'
import {
	panelIdentity,
	panelTab,
	panelTabId,
	readPanelIdentity,
	resolvePanelTool,
	type PanelRegion,
} from './panelTabs'
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
	type Node,
	type IJsonModel,
	type IJsonTabNode,
	type Action,
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
	enableClose: false,
	enableDrag: false,
	enableRename: false,
	enablePin: false,
	minHeight: 0,
}
export const pluginInspectorTab = { ...navigationTab, id: 'plugin-inspector', name: '插件面板' }

/** Documents stay in the center; auxiliary tools belong to their declared region. */
function allowWorkspaceDrop(tabs: readonly TabNode[], target: Node, location: DockLocation) {
	const regions: Record<string, string> = {
		navigation: 'border_left',
		'plugin-inspector': 'border_right',
	}
	return tabs.every((tab) => {
		const panel = readPanelIdentity(tab.toJson())
		const region = panel ? `border_${panel.region}` : regions[tab.getId()]
		if (region) return target.getId() === region && location === DockLocation.CENTER
		let node: Node | undefined = target
		while (node) {
			if (node instanceof BorderNode) return false
			node = node.getParent()
		}
		// Documents split within the central editing area.
		return target instanceof TabSetNode || target instanceof TabGroupNode
	})
}

function validPanelLayout(model: Model) {
	try {
		for (const [side, id] of [
			['left', 'navigation'],
			['right', 'plugin-inspector'],
		] as const) {
			const border = model.getNodeById(`border_${side}`)
			if (!(border instanceof BorderNode) || border.getChildren()[0]?.getId() !== id) return false
		}
		let valid = true
		model.visitNodes((node) => {
			if (!(node instanceof TabNode)) return
			const identity = readPanelIdentity(node.toJson())
			if (
				identity &&
				(!(node.getParent() instanceof BorderNode) ||
					node.getParent()?.getId() !== `border_${identity.region}`)
			)
				valid = false
		})
		for (const side of ['left', 'right', 'bottom'] as const) {
			const border = model.getNodeById(`border_${side}`)
			if (!(border instanceof BorderNode)) return false
			const config = border.getConfig() ?? {}
			if (
				config.panelOwner !== undefined &&
				(typeof config.panelOwner !== 'string' ||
					formatPluginNodeReference(parsePluginNodeReference(config.panelOwner)) !==
						config.panelOwner)
			)
				return false
			const archives = config.panelArchives
			if (archives === undefined) continue
			if (!archives || typeof archives !== 'object' || Array.isArray(archives)) return false
			for (const [owner, archive] of Object.entries(archives)) {
				if (
					formatPluginNodeReference(parsePluginNodeReference(owner)) !== owner ||
					!archive ||
					typeof archive !== 'object' ||
					Array.isArray(archive)
				)
					return false
				const { tabs, selected } = archive as { tabs?: unknown; selected?: unknown }
				if (!Array.isArray(tabs) || (selected !== undefined && typeof selected !== 'string'))
					return false
				const ids = new Set<string>()
				for (const tab of tabs) {
					if (
						!tab ||
						typeof tab !== 'object' ||
						tab.type !== 'tab' ||
						tab.component !== 'worksplit.tool'
					)
						return false
					const identity = readPanelIdentity(tab)
					if (!identity || identity.owner !== owner || identity.region !== side || ids.has(tab.id))
						return false
					ids.add(tab.id)
				}
				if (
					selected !== undefined &&
					!ids.has(selected) &&
					selected !==
						(side === 'left' ? 'navigation' : side === 'right' ? 'plugin-inspector' : undefined)
				)
					return false
			}
		}
		return valid
	} catch {
		return false
	}
}
const panelLayoutPolicy = {
	allows: validPanelLayout,
	allowsAction(model: Model, action: Action) {
		try {
			const candidate = Model.fromJson(model.toJson())
			candidate.doAction(action)
			return validPanelLayout(candidate)
		} catch {
			return false
		}
	},
	allowsDrop(_model: Model, _drag: Node, target: Node, _location: DockLocation, index?: number) {
		return !(['border_left', 'border_right'].includes(target.getId()) && index === 0)
	},
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
				config: { navigationMode: 'icons' },
				selected: compact ? -1 : 0,
				enableDrop: true,
				children: [{ ...navigationTab }],
			},
			{
				type: 'border',
				location: 'right',
				show: false,
				size: 320,
				selected: -1,
				enableDrop: true,
				children: [{ ...pluginInspectorTab }],
			},
			{
				type: 'border',
				location: 'bottom',
				show: false,
				size: 240,
				selected: -1,
				enableDrop: true,
				children: [],
			},
		],
		layout: {
			type: 'row',
			children: [
				{ type: 'tabset', id: 'main', active: true, enableDeleteWhenEmpty: false, children: [] },
			],
		},
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
				allowDrop: allowWorkspaceDrop,
				resolveTool: resolvePanelTool,
				layoutPolicy: panelLayoutPolicy,
				tools: [
					{ id: 'navigation', render: () => <PluginNavigation /> },
					{ id: 'plugin-inspector', render: () => <PluginTool /> },
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
	private panelEntries: readonly WorkbenchLayoutEntry[] = []
	private panelEntriesOwner?: string
	private currentPanelOwner() {
		const id = this.workbench.getActiveDocument()?.id
		const owner = id ? this.documents.get(id)?.plugin : undefined
		return owner ? formatPluginNodeReference(owner) : undefined
	}
	isPanelOpen(entry: WorkbenchLayoutEntry): boolean {
		const identity = panelIdentity(entry)
		const node = Model.fromJson(this.workbench.getLayout()).getNodeById(
			panelTabId(identity.owner, identity.key),
		)
		return node instanceof TabNode && readPanelIdentity(node.toJson())?.region === identity.region
	}
	async openPanel(entry: WorkbenchLayoutEntry): Promise<void> {
		const identity = panelIdentity(entry)
		const currentEntry = () => {
			if (identity.owner !== this.currentPanelOwner())
				throw new Error('当前插件已改变，请切回该插件页面后重新打开面板')
			const current =
				this.panelEntriesOwner === identity.owner &&
				this.panelEntries.find(
					(item) =>
						item.descriptor.key === identity.key &&
						item.placement.kind === 'panel' &&
						item.placement.region === identity.region,
				)
			if (!current) throw new Error('该面板已不在当前插件发布的扩展中，请刷新扩展列表')
			return current
		}
		currentEntry()
		await this.syncWorkspacePanels()
		const current = currentEntry()
		const tab = panelTab(current)
		const existing = Model.fromJson(this.workbench.getLayout()).getNodeById(tab.id!)
		if (
			existing instanceof TabNode &&
			readPanelIdentity(existing.toJson())?.region !== identity.region
		) {
			const result = await this.workbench.close(tab.id!)
			if (result.status !== 'closed') throw new Error('面板区域已改变，但旧面板无法关闭')
			this.check(result)
		} else if (existing instanceof TabNode && existing.getName() !== tab.name) {
			this.check(
				await this.workbench.dispatch(Actions.updateNodeAttributes(tab.id!, { name: tab.name })),
			)
		}
		currentEntry()
		if (!Model.fromJson(this.workbench.getLayout()).getNodeById(tab.id!)) {
			const result = await this.workbench.dispatch(
				Actions.addNode(tab, `border_${identity.region}`, DockLocation.CENTER, -1, false),
			)
			if (result.status !== 'applied') throw new Error('无法打开插件扩展面板')
		}
		currentEntry()
		const border = Model.fromJson(this.workbench.getLayout()).getNodeById(
			`border_${identity.region}`,
		) as BorderNode
		// SELECT_TAB toggles a selected Border tab; setting its index is idempotent.
		await this.workbench.dispatch(
			Actions.updateNodeAttributes(border.getId(), {
				show: true,
				selected: border.getChildren().findIndex((node) => node.getId() === tab.id),
			}),
		)
		await this.syncWorkspacePanels()
	}
	/** Native layout owns active tabs. Inactive owner layouts are UI-only archives in Border config. */
	syncWorkspacePanels(entries?: readonly WorkbenchLayoutEntry[]): Promise<void> {
		if (entries) {
			const owner = this.currentPanelOwner()
			this.panelEntriesOwner = owner
			this.panelEntries = entries.filter(
				(entry) =>
					entry.placement.kind === 'panel' &&
					formatPluginNodeReference(entry.target.node) === owner,
			)
		}
		this.panelsPending = true
		return (this.synchronizingPanels ??= Promise.resolve().then(async () => {
			try {
				while (this.panelsPending && !this.disposing) {
					this.panelsPending = false
					const owner = this.currentPanelOwner()
					for (const side of ['left', 'right', 'bottom'] as const) {
						let border = Model.fromJson(this.workbench.getLayout()).getNodeById(`border_${side}`)
						if (!(border instanceof BorderNode)) continue
						const config = border.getConfig() ?? {}
						if (config.panelOwner !== owner) {
							const archives: Record<string, { tabs: IJsonTabNode[]; selected?: string }> = {
								...config.panelArchives,
							}
							const tabs = border
								.getChildren()
								.filter((node) => node instanceof TabNode && readPanelIdentity(node.toJson()))
								.map((node) => (node as TabNode).toJson())
							if (config.panelOwner)
								archives[config.panelOwner] = { tabs, selected: border.getSelectedNode()?.getId() }
							const restore = owner ? archives[owner] : undefined
							if (owner) delete archives[owner]
							for (const tab of tabs) {
								const result = await this.workbench.close(tab.id!)
								if (result.status !== 'closed') throw new Error('插件上下文切换时无法释放旧面板')
								this.check(result)
							}
							for (const tab of restore?.tabs ?? []) {
								const identity = readPanelIdentity(tab)
								if (!identity || identity.owner !== owner || identity.region !== side)
									throw new Error('保存的插件面板不属于当前区域或插件')
								const result = await this.workbench.dispatch(
									Actions.addNode(tab, `border_${side}`, DockLocation.CENTER, -1, false),
								)
								if (result.status !== 'applied') throw new Error('无法恢复插件面板布局')
							}
							const expanded = border.getSelected() >= 0
							border = Model.fromJson(this.workbench.getLayout()).getNodeById(
								`border_${side}`,
							) as BorderNode
							const selectedId = restore
								? restore.selected
								: expanded
									? side === 'right'
										? 'plugin-inspector'
										: side === 'left'
											? 'navigation'
											: undefined
									: undefined
							this.check(
								await this.workbench.dispatch(
									Actions.updateNodeAttributes(border.getId(), {
										config: { ...config, panelOwner: owner, panelArchives: archives },
										selected: selectedId
											? border.getChildren().findIndex((node) => node.getId() === selectedId)
											: -1,
									}),
								),
							)
						}
						const show = this.panelAvailable(side)
						const current = Model.fromJson(this.workbench.getLayout()).getNodeById(
							`border_${side}`,
						) as BorderNode
						if (current.isShowing() !== show)
							this.check(
								await this.workbench.dispatch(
									Actions.updateNodeAttributes(current.getId(), { show }),
								),
							)
					}
				}
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
	isToolVisible(id: string): boolean {
		const model = Model.fromJson(this.workbench.getLayout())
		const node = model.getNodeById(id)
		if (!(node instanceof TabNode)) return false
		const parent = node.getParent()
		if (!(parent instanceof BorderNode)) return false
		const side = parent.getLocation().getName() as PanelRegion
		if (!this.panelAvailable(side)) return false
		if (!parent.isShowing()) return false
		return parent.getSelectedNode()?.getId() === id
	}
	panelAvailable(side: PanelRegion): boolean {
		const owner = this.currentPanelOwner()
		if (side === 'right') return !!owner
		if (side === 'left' && this.activeWorkspace() === 'plugins') return true
		const border = Model.fromJson(this.workbench.getLayout()).getNodeById(`border_${side}`)
		return (
			!!owner &&
			border instanceof BorderNode &&
			border
				.getChildren()
				.some(
					(node) => node instanceof TabNode && readPanelIdentity(node.toJson())?.owner === owner,
				)
		)
	}
	async showTool() {
		if (!this.panelAvailable('left')) return
		this.check(
			await this.workbench.dispatch(Actions.updateNodeAttributes('border_left', { selected: 0 })),
		)
		await this.syncWorkspacePanels()
	}
	async toggleTool(id: string) {
		const model = Model.fromJson(this.workbench.getLayout())
		const node = model.getNodeById(id)
		const border = node?.getParent()
		if (!(node instanceof TabNode) || !(border instanceof BorderNode)) return
		const index = border.getChildren().findIndex((child) => child.getId() === id)
		this.check(
			await this.workbench.dispatch(
				Actions.updateNodeAttributes(border.getId(), {
					show: true,
					selected: this.isToolVisible(id) ? -1 : index,
				}),
			),
		)
	}
	async toggleBorder(side: 'left' | 'right' | 'bottom') {
		if (!this.panelAvailable(side)) return
		const id = `border_${side}`
		const model = Model.fromJson(this.workbench.getLayout())
		const container = model.getNodeById(id)
		if (!(container instanceof BorderNode))
			throw new Error('保存的布局缺少工具区域，请恢复默认布局。')
		this.check(
			await this.workbench.dispatch(
				Actions.updateNodeAttributes(id, {
					selected: container.getSelected() >= 0 ? -1 : 0,
				}),
			),
		)
		await this.syncWorkspacePanels()
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

import {
	formatPluginNodeReference,
	parsePluginNodeReference,
	pluginNodeAddressEqual,
} from '@pluxel/core'
import {
	readWorkbenchShortcuts,
	type WorkbenchLayoutEntry,
	type WorkbenchShortcut,
} from '@pluxel/workbench/client'
import {
	panelIdentity,
	panelTab,
	panelTabId,
	readPanelIdentity,
	resolvePanelTool,
	type PanelRegion,
} from './panelTabs'
import { createWorkbench, type StartResult, type OperationResult } from '@worksplit/react'
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
	component: 'pluxel.navigation',
	enableClose: false,
	enableDrag: false,
	enableRename: false,
	enablePin: false,
	minHeight: 0,
}
export const pluginInspectorTab = {
	...navigationTab,
	id: 'plugin-inspector',
	name: '插件面板',
	component: 'pluxel.inspector',
}

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
			if (side === 'left' && config.shortcuts !== undefined)
				readWorkbenchShortcuts(config.shortcuts)
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
						tab.component !== 'pluxel.plugin-panel'
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
			const root = model.getRootRow()
			if (!root) return false
			// This policy reads panel identities, parent regions and Border archives only.
			// Native node JSON preserves those facts without Model.toJson()'s save events.
			const candidate = Model.fromJson(
				structuredClone({
					global: model.getGlobalAttributes(),
					layout: root.toJson(),
					borders: model.getBorderSet().toJson(),
				}),
			)
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

export function defaultWorkspaceLayout(
	compact = window.innerWidth <= 680,
	shortcuts: readonly WorkbenchShortcut[] = [],
): IJsonModel {
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
				config: { navigationMode: 'icons', shortcuts },
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
	resolveTitle?: (href: string) => string | undefined
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
	private disposing?: Promise<void>
	private synchronizingPanels?: Promise<void>
	private panelsPending = false
	private readonly initialShortcuts: readonly WorkbenchShortcut[]

	constructor(
		options: {
			basepath?: string
			snapshot?: unknown
			storage?: WorkspaceSnapshotStorage
			initialShortcuts?: readonly WorkbenchShortcut[]
		} = {},
	) {
		this.initialShortcuts = readWorkbenchShortcuts(
			options.initialShortcuts === undefined ? [] : options.initialShortcuts,
		)
		this.basepath = options.basepath ?? readWorkbenchUiBasePath()
		this.storage =
			options.storage ?? new WorkspaceSnapshotStorage(workspaceStorageKey(this.basepath))
		const snapshot = options.snapshot !== undefined ? options.snapshot : this.storage.readSnapshot()
		try {
			this.workbench = createWorkbench({
				workspaceId: `pluxel:${this.basepath}`,
				home: { mode: 'route', href: this.basepath },
				previewScope: 'workspace',
				captureSnapshotOnClose: true,
				createRouter: (history) =>
					createAppRouter({ history, uiBasePath: this.basepath, Wrap: WorkbenchDocumentRoot }),
				initial:
					snapshot === undefined
						? { layout: defaultWorkspaceLayout(undefined, this.initialShortcuts) }
						: { snapshot },
				allowDrop: allowWorkspaceDrop,
				resolveTool: resolvePanelTool,
				layoutPolicy: panelLayoutPolicy,
				tools: {
					'pluxel.navigation': { render: () => <PluginNavigation /> },
					'pluxel.inspector': { render: () => <PluginTool /> },
				},
				onIssue: ({ code, error }) => {
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
		const node = this.workbench.model.getNodeById(panelTabId(identity.owner, identity.key))
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
		const existing = this.workbench.model.getNodeById(tab.id!)
		if (
			existing instanceof TabNode &&
			readPanelIdentity(existing.toJson())?.region !== identity.region
		) {
			const result = await this.workbench.close(tab.id!)
			if (result.status !== 'applied') throw new Error('面板区域已改变，但旧面板无法关闭')
			this.check(result)
		} else if (existing instanceof TabNode && existing.getName() !== tab.name) {
			this.check(
				await this.workbench.dispatch(Actions.updateNodeAttributes(tab.id!, { name: tab.name })),
			)
		}
		currentEntry()
		if (!this.workbench.model.getNodeById(tab.id!)) {
			const result = await this.workbench.dispatch(
				Actions.addNode(tab, `border_${identity.region}`, DockLocation.CENTER, -1, false),
			)
			if (result.status !== 'applied') throw new Error('无法打开插件扩展面板')
		}
		currentEntry()
		this.check(await this.workbench.activate(tab.id!))
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
						let border = this.workbench.model.getNodeById(`border_${side}`)
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
								if (result.status !== 'applied') throw new Error('插件上下文切换时无法释放旧面板')
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
							border = this.workbench.model.getNodeById(`border_${side}`) as BorderNode
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
						const current = this.workbench.model.getNodeById(`border_${side}`) as BorderNode
						if (current.isShowing() !== show)
							this.check(
								await this.workbench.dispatch(
									Actions.updateNodeAttributes(current.getId(), { show }),
								),
							)
					}
				}
				return undefined
			} finally {
				this.synchronizingPanels = undefined
			}
		}))
	}
	navigationMode(): 'icons' | 'labels' {
		return this.navigationConfig().navigationMode === 'labels' ? 'labels' : 'icons'
	}
	sidebarShortcuts(): readonly WorkbenchShortcut[] {
		return (
			(this.navigationConfig().shortcuts as readonly WorkbenchShortcut[] | undefined) ??
			this.initialShortcuts
		)
	}
	isSidebarShortcut(shortcut: WorkbenchShortcut): boolean {
		return this.sidebarShortcuts().some(
			(saved) =>
				saved.entryKey === shortcut.entryKey &&
				pluginNodeAddressEqual(saved.target, shortcut.target),
		)
	}
	async setSidebarShortcut(shortcut: WorkbenchShortcut, pinned: boolean): Promise<void> {
		const [validated] = readWorkbenchShortcuts([shortcut])
		const current = this.sidebarShortcuts()
		const matches = (saved: WorkbenchShortcut) =>
			saved.entryKey === validated!.entryKey &&
			pluginNodeAddressEqual(saved.target, validated!.target)
		const shortcuts = pinned
			? current.some(matches)
				? current.map((saved) => (matches(saved) ? validated! : saved))
				: [...current, validated!]
			: current.filter((saved) => !matches(saved))
		const result = await this.workbench.dispatch(
			Actions.updateNodeAttributes('border_left', {
				config: { ...this.navigationConfig(), shortcuts },
			}),
		)
		if (result.status !== 'applied') throw new Error('侧栏偏好未保存，请重试')
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
		const node = this.workbench.model.getNodeById('border_left')
		return node instanceof BorderNode ? (node.getConfig() ?? {}) : {}
	}
	isToolVisible(id: string): boolean {
		const model = this.workbench.model
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
		const border = this.workbench.model.getNodeById(`border_${side}`)
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
		const model = this.workbench.model
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
		const model = this.workbench.model
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
			const result = await this.workbench.start(
				browser
					? {
							browser: {
								onOutsideNavigate: ({ snapshot, cleanup }) => {
									this.storage.finish(snapshot)
									void cleanup.then((cleanupResult) => {
										this.check(cleanupResult)
										// The browser already visited the host entry. Reload it without pushing again.
										return location.reload()
									})
								},
							},
						}
					: { href },
			)
			this.check(result)
			if (result.status === 'applied') {
				if (this.navigationConfig().shortcuts === undefined) {
					const seeded = await this.workbench.dispatch(
						Actions.updateNodeAttributes('border_left', {
							config: { ...this.navigationConfig(), shortcuts: this.initialShortcuts },
						}),
					)
					if (seeded.status !== 'applied') throw new Error('无法初始化侧栏偏好')
				}
				this.storage.connect(() => this.workbench.createSnapshot())
				window.addEventListener('beforeunload', this.beforeUnload)
			}
			return result
		})())
	}
	check(result: OperationResult<unknown>) {
		if (result.status === 'failed') this.report(result.error)
		else if (result.status === 'denied' && result.reason !== 'decision')
			this.report(new Error(`操作未完成：${result.detail ?? result.reason}`))
		if ('cleanupErrors' in result && result.cleanupErrors.length > 0)
			this.report(new AggregateError(result.cleanupErrors, '操作已结算，但资源释放失败'))
	}
	report(error: unknown) {
		notifyAndRecord({
			title: '工作区',
			message: error instanceof Error ? error.message : String(error),
			color: 'red',
		})
	}
	async leave(href: string): Promise<void> {
		const result = await this.workbench.closeWorkspace({ destination: href })
		this.check(result)
		if (result.status !== 'applied') return
		this.storage.finish(result.value.snapshot)
		location.assign(href)
	}
	private beforeUnload = (event: BeforeUnloadEvent) => {
		if (![...this.documents.values()].some((document) => document.blocksUnload())) return
		event.preventDefault()
		event.returnValue = ''
	}
	async closeDocuments(): Promise<boolean> {
		const documents = this.workbench.getDocuments()
		const protectedDocuments = documents.filter(
			({ node }) => node.isPinned() || !node.isEnableClose(),
		)
		if (protectedDocuments.length > 0) {
			this.report(
				new Error(
					`请先解除固定或关闭保护：${protectedDocuments.map((document) => document.title).join('、')}`,
				),
			)
			return false
		}
		if (documents.length === 0) return true
		const result = await this.workbench.close(documents.map(({ id }) => id))
		this.check(result)
		return result.status === 'applied' && result.cleanupErrors.length === 0
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
		if (!this.storage.reset()) return false
		// Stop pending writes before a full page replacement; no unsupported Model replacement.
		this.storage.blocked = true
		location.assign(this.basepath)
		return true
	}
	dispose(): Promise<void> {
		return (this.disposing ??= (async () => {
			this.storage.close()
			window.removeEventListener('beforeunload', this.beforeUnload)
			this.check(await this.workbench.dispose())
		})())
	}
}

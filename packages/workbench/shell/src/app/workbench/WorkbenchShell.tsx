import { Workbench, useWorkbenchState } from '@worksplit/react'
import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Group,
	Indicator,
	Menu,
	Modal,
	Popover,
	ScrollArea,
	Stack,
	Text,
	Tooltip,
} from '@mantine/core'
import { openConfirmModal } from '@mantine/modals'
import { useHotkeys } from '@tanstack/react-hotkeys'
import {
	IconBell,
	IconPlus,
	IconDots,
	IconFile,
	IconInfoCircle,
	IconTerminal2,
	IconLayoutSidebarLeftExpand,
	IconLayoutSidebarRight,
	IconLayoutBottombar,
	IconSearch,
	IconShieldLock,
	IconX,
} from '@tabler/icons-react'
import { Actions, type IJsonModel, type ILayoutApi } from 'flexlayout-react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ThemeCustomizer } from '../../theme'
import { useNotificationCenter } from '../notifications/NotificationCenterProvider'
import { useProduct } from '../product'
import { WorkbenchNavigationProvider, useWorkbenchNavigation } from './context'
import { ActivityRail } from './ActivityRail'
import { pluginNodeAddressEqual } from '@pluxel/core'
import { useWorkbenchTargetSnapshot } from '../../workbench/runtime'
import { navigationTab } from './session'
import { useWorkspaceSession } from './workspaceContext'
import { WorkspaceNavigation } from './WorkspaceNavigation'
import { useNativeMenus } from './nativeMenus'
import { WORKBENCH_HOTKEYS, WORKBENCH_HOTKEY_LABELS, WORKBENCH_SHORTCUT_ITEMS } from './shortcuts'
import { WorkbenchUpdateStatus } from './shell/WorkbenchUpdateStatus'
import '@worksplit/react/style.css'
import 'flexlayout-react/style/light.css'
import './styles.scss'

export function WorkbenchShell() {
	const session = useWorkspaceSession()
	const navigation = useWorkbenchNavigation()
	const product = useProduct()
	const root = useRef<HTMLDivElement>(null)
	const layoutRef = useRef<ILayoutApi>(null)
	const [searchOpen, setSearchOpen] = useState(false)
	const [newTabAnchor, setNewTabAnchor] = useState<string>()
	const showSearch = useCallback(() => {
		setNewTabAnchor(undefined)
		setSearchOpen(true)
	}, [])
	const [helpOpen, setHelpOpen] = useState(false)
	const [pending, setPending] = useState(false)
	const menu = useNativeMenus(session, root)
	const count = useWorkbenchState(session.workbench, () => session.workbench.getDocuments().length)
	const activeDocumentId = useWorkbenchState(session.workbench, (state) => state.activeDocumentId)
	const activeGroup = useWorkbenchState(
		session.workbench,
		() => session.workbench.getEditingContext().activeGroupId,
	)
	const borders = useWorkbenchState(session.workbench, () => session.workbench.getLayout().borders)
	const logsVisible = useWorkbenchState(session.workbench, () =>
		session.isToolVisible('plugin-logs'),
	)
	const unifiedNavigation =
		borders
			?.find((border) => border.location === 'left')
			?.children?.every(function onlyNavigation(node): boolean {
				return 'children' in node && node.children
					? node.children.every(onlyNavigation)
					: node.id === 'navigation'
			}) ?? false
	const borderVisible = (side: string) => {
		if (side === 'bottom') return logsVisible
		const border = borders?.find((item) => item.location === side)
		return !!border && border.show !== false && (border.selected ?? -1) >= 0
	}
	const toggleBorder = useCallback(
		(side: 'left' | 'right' | 'bottom') => {
			void (side === 'bottom' ? session.toggleLogs() : session.toggleBorder(side)).catch(
				(error: unknown) => session.report(error),
			)
		},
		[session],
	)
	const contentRevision = useSyncExternalStore(
		session.subscribeContentState,
		session.getContentRevision,
	)
	const activeWorkspace = session.activeWorkspace()
	const owner = activeDocumentId ? session.documents.get(activeDocumentId)?.plugin : undefined
	const ownerSnapshot = useWorkbenchTargetSnapshot(owner ?? null)
	const hasLeftPanels =
		!!owner &&
		(ownerSnapshot.layout?.entries ?? []).some(
			(entry) =>
				entry.placement.kind === 'panel' &&
				entry.placement.region === 'left' &&
				pluginNodeAddressEqual(entry.target.node, owner),
		)
	useEffect(() => {
		void session.syncWorkspacePanels(hasLeftPanels).catch((error: unknown) => session.report(error))
	}, [activeDocumentId, contentRevision, hasLeftPanels, session])
	const storageError = useSyncExternalStore(session.storage.subscribe, session.storage.getSnapshot)
	useEffect(() => {
		layoutRef.current?.redraw()
	}, [contentRevision])
	const restoreWorkspaceFocus = useCallback(() => {
		requestAnimationFrame(() => {
			const active = document.activeElement
			// A removed tab or a native container hidden by maximize cannot receive the next scoped key.
			if (
				active === document.body ||
				(active instanceof HTMLElement &&
					root.current?.contains(active) &&
					active.closest<HTMLElement>('.flexlayout__tabset_container')?.style.display === 'none')
			)
				root.current?.focus()
		})
	}, [])
	const showNavigation = useCallback(() => {
		void session
			.showTool(navigationTab)
			.then(() => {
				if (session.activeWorkspace() !== 'plugins') navigation.navigate('/plugins')
				return undefined
			})
			.catch((error: unknown) => session.report(error))
	}, [navigation, session])
	const closeActive = useCallback(() => {
		const id = session.workbench.getActiveDocument()?.id
		if (id)
			void session.workbench
				.close(id)
				.then((result) => {
					session.check(result)
					restoreWorkspaceFocus()
					return result
				})
				.catch((error: unknown) => session.report(error))
	}, [restoreWorkspaceFocus, session])
	const cycle = useCallback(
		(delta: number) => {
			const ids: string[] = []
			const documents = new Set(session.workbench.getDocuments().map((document) => document.id))
			const visit = (node: { type?: string; id?: string; children?: unknown[] }) => {
				if (node.type === 'tab' && node.id && documents.has(node.id)) ids.push(node.id)
				node.children?.forEach((child) => visit(child as Parameters<typeof visit>[0]))
			}
			const layout: IJsonModel = session.workbench.getLayout()
			visit(layout.layout)
			layout.borders?.forEach(visit)
			if (ids.length === 0) return
			const index = ids.indexOf(session.workbench.getActiveDocument()?.id ?? '')
			session.workbench.activate(ids[(index + delta + ids.length) % ids.length]!)
		},
		[session],
	)
	const maximize = useCallback(() => {
		const group = session.workbench.getEditingContext().activeGroupId
		if (!group || group.startsWith('border_')) return
		void session.workbench
			.dispatch(Actions.maximizeToggle(group))
			.then((result) => {
				session.check(result)
				restoreWorkspaceFocus()
				return result
			})
			.catch((error: unknown) => session.report(error))
	}, [restoreWorkspaceFocus, session])
	useHotkeys(
		[
			{
				hotkey: WORKBENCH_HOTKEYS.focusSearch,
				callback: showSearch,
				options: { target: document, ignoreInputs: false },
			},
			{ hotkey: WORKBENCH_HOTKEYS.showNavigation, callback: () => toggleBorder('left') },
			{ hotkey: WORKBENCH_HOTKEYS.closeActiveTab, callback: closeActive },
			{ hotkey: WORKBENCH_HOTKEYS.prevTab, callback: () => cycle(-1) },
			{ hotkey: WORKBENCH_HOTKEYS.nextTab, callback: () => cycle(1) },
			{ hotkey: WORKBENCH_HOTKEYS.maximize, callback: maximize },
		],
		{
			target: root,
			ignoreInputs: true,
			preventDefault: true,
			enabled: !searchOpen && !helpOpen && !pending && !menu.popup,
		},
	)
	const native = useMemo(
		() => ({
			...menu.native,
			onRenderTab: (
				node: Parameters<NonNullable<typeof menu.native.onRenderTab>>[0],
				values: Parameters<NonNullable<typeof menu.native.onRenderTab>>[1],
			) => {
				const document = session.workbench.getDocument(node.getId())
				values.leading =
					node.getId() === 'navigation' ? (
						<IconLayoutSidebarLeftExpand size={14} />
					) : node.getId() === 'plugin-logs' ? (
						<IconTerminal2 size={14} />
					) : node.getId() === 'plugin-inspector' ? (
						<IconInfoCircle size={14} />
					) : (
						<IconFile size={14} />
					)
				if (document && node.getId() === activeDocumentId)
					values.buttons.push(
						<ActionIcon
							key="new-document"
							size="xs"
							variant="subtle"
							aria-label="新建标签页"
							title="新建标签页"
							onPointerDown={(event) => event.stopPropagation()}
							onMouseDown={(event) => event.stopPropagation()}
							onClick={(event) => {
								event.stopPropagation()
								setNewTabAnchor(node.getId())
								setSearchOpen(true)
							}}
						>
							<IconPlus size={14} />
						</ActionIcon>,
					)
				const dirty = session.documents.get(node.getId())?.isDirty()
				values.content = (
					<span className="plx-workspace__tab-label" title={document?.href}>
						<span>{node.getName()}</span>
						{document?.preview && <span className="plx-workspace__tab-preview">预览</span>}
						{dirty && (
							<span
								className="plx-workspace__tab-dirty"
								role="status"
								aria-label="未保存的更改"
								title="未保存的更改"
							>
								●
							</span>
						)}
					</span>
				)
			},
		}),
		[menu.native, session, activeDocumentId],
	)
	const closeDocuments = () =>
		openConfirmModal({
			title: '关闭所有文档',
			children:
				'将关闭全部文档，包括边栏与折叠分组中的文档；入口工具保持打开。固定或受保护文档会拒绝整批关闭，未保存更改仍需逐项决定。',
			labels: { confirm: '关闭所有文档', cancel: '保留工作区' },
			confirmProps: { color: 'red' },
			onConfirm: () => {
				setPending(true)
				void session
					.closeDocuments()
					.catch((error: unknown) => session.report(error))
					.finally(() => setPending(false))
			},
		})
	return (
		<div
			className={`plx-workspace${unifiedNavigation ? ' plx-workspace--unified-navigation' : ''}`}
			ref={root}
			tabIndex={-1}
			onKeyDownCapture={menu.onKeyDown}
		>
			<header className="plx-workspace__toolbar">
				<Group gap={4} wrap="nowrap" className="plx-workspace__primary">
					<Text fw={650} size="sm" className="plx-workspace__brand" truncate="end">
						{product?.displayName ?? 'Pluxel'}
					</Text>
					<Button
						variant="subtle"
						size="compact-xs"
						leftSection={<IconSearch size={14} />}
						onClick={showSearch}
						aria-label="查找所有工作区入口"
						className="plx-workspace__search-button"
					>
						<span className="plx-workspace__search-label">
							查找入口 <kbd>{WORKBENCH_HOTKEY_LABELS.focusSearch}</kbd>
						</span>
					</Button>
					<Menu position="bottom-start" shadow="md" width={265}>
						<Menu.Target>
							<Button
								size="compact-xs"
								variant="subtle"
								rightSection={<IconDots size={14} />}
								disabled={pending}
							>
								工作区
							</Button>
						</Menu.Target>
						<Menu.Dropdown>
							<Menu.Label>{count} 个文档 · 原生停靠工作区</Menu.Label>
							<Menu.Item
								onClick={() => {
									void session
										.setNavigationView('plugins')
										.then(showNavigation)
										.catch((error: unknown) => session.report(error))
								}}
							>
								显示插件目录
							</Menu.Item>
							<Menu.Item onClick={() => navigation.navigate('/apps')}>显示应用目录</Menu.Item>
							<Menu.Item
								disabled={!count}
								onClick={closeActive}
								rightSection={<kbd>{WORKBENCH_HOTKEY_LABELS.closeActiveTab}</kbd>}
							>
								关闭活动文档
							</Menu.Item>
							<Menu.Item
								disabled={!activeGroup || activeGroup.startsWith('border_')}
								onClick={maximize}
							>
								最大化或还原活动容器
							</Menu.Item>
							<Menu.Item onClick={() => setHelpOpen(true)}>键盘操作</Menu.Item>
							<Menu.Divider />
							<Menu.Item color="red" disabled={!count} onClick={closeDocuments}>
								关闭所有文档（保留布局）
							</Menu.Item>
							<Menu.Item
								onClick={() => {
									setPending(true)
									void session
										.resetLayout()
										.catch((error: unknown) => session.report(error))
										.finally(() => setPending(false))
								}}
							>
								恢复默认布局（关闭文档并重新载入）
							</Menu.Item>
						</Menu.Dropdown>
					</Menu>
				</Group>
				<Group
					gap={4}
					wrap="nowrap"
					className="plx-workspace__layout-controls"
					aria-label="布局控制"
				>
					{(
						[
							['left', '左侧导航', IconLayoutSidebarLeftExpand],
							['right', '右侧面板', IconLayoutSidebarRight],
							['bottom', '底部面板', IconLayoutBottombar],
						] as const
					).map(([side, label, Icon]) => (
						<Tooltip key={side} label={`${borderVisible(side) ? '收起' : '显示'}${label}`}>
							<ActionIcon
								size="sm"
								variant={borderVisible(side) ? 'light' : 'subtle'}
								aria-label={label}
								aria-pressed={borderVisible(side)}
								disabled={
									!activeWorkspace ||
									(side === 'left' && activeWorkspace === 'apps' && !hasLeftPanels)
								}
								onClick={() => toggleBorder(side)}
							>
								<Icon size={17} />
							</ActionIcon>
						</Tooltip>
					))}
				</Group>
				<Group gap={4} wrap="nowrap" ml="auto" className="plx-workspace__utilities">
					<WorkbenchUpdateStatus />
					<NotificationHistory />
					<Tooltip label="认证与安全">
						<ActionIcon
							variant="subtle"
							size="sm"
							aria-label="认证与安全"
							onClick={() => navigation.navigate('/security')}
						>
							<IconShieldLock size={17} />
						</ActionIcon>
					</Tooltip>
					<ThemeCustomizer compact />
				</Group>
			</header>
			{storageError && (
				<Alert color="yellow" title="布局尚未保存" className="plx-workspace__storage-error">
					<Group gap="sm" align="start">
						<Text size="xs" style={{ flex: 1 }}>
							{storageError}
						</Text>
						<Button
							variant="light"
							color="yellow"
							size="compact-xs"
							onClick={() => session.storage.retry()}
						>
							重试保存
						</Button>
					</Group>
				</Alert>
			)}
			<div className="plx-workspace__body">
				<ActivityRail onShowPlugins={showNavigation} />
				<Workbench
					className="plx-workspace__layout"
					workbench={session.workbench}
					native={native}
					layoutRef={layoutRef}
					empty={
						<Stack gap="xs" align="center">
							<Text c="dimmed" size="sm">
								工作区没有打开的文档
							</Text>
							<Button variant="light" size="xs" onClick={showSearch}>
								查找页面或插件入口
							</Button>
						</Stack>
					}
				/>
			</div>
			{menu.popup}
			<Modal
				opened={searchOpen}
				onClose={() => setSearchOpen(false)}
				title={newTabAnchor ? '新建标签页' : '查找工作区入口'}
				size="lg"
				centered
			>
				<div className="plx-workspace__search">
					<WorkbenchNavigationProvider
						value={{
							...navigation,
							openTab: (input) => navigation.openTab({ ...input, afterDocumentId: newTabAnchor }),
						}}
					>
						<WorkspaceNavigation
							openMode={newTabAnchor ? 'new' : 'reuse'}
							autofocus
							onChosen={() => setSearchOpen(false)}
							onShowNavigation={showNavigation}
						/>
					</WorkbenchNavigationProvider>
				</div>
			</Modal>
			<Modal
				opened={helpOpen}
				onClose={() => setHelpOpen(false)}
				title="工作区键盘操作"
				size="lg"
				centered
			>
				<Stack gap="xs">
					{WORKBENCH_SHORTCUT_ITEMS.map(([key, description]) => (
						<Group key={key} wrap="nowrap" align="start">
							<Badge variant="light" color="gray" miw={125}>
								{key}
							</Badge>
							<Text size="sm">{description}</Text>
						</Group>
					))}
					<Text c="dimmed" size="xs">
						工作区命令忽略文本输入；查找入口可在输入时使用。箭头键遵循原生标签和菜单的焦点规则。
					</Text>
				</Stack>
			</Modal>
		</div>
	)
}

function NotificationHistory() {
	const center = useNotificationCenter()
	const [opened, setOpened] = useState(false)
	return (
		<Popover opened={opened} onChange={setOpened} position="bottom-end" width={360} shadow="md">
			<Popover.Target>
				<Indicator disabled={!center.unread} label={center.unread} size={13} offset={2}>
					<ActionIcon
						variant="subtle"
						size="sm"
						aria-label={`通知历史，${center.unread} 条未读`}
						onClick={() => {
							setOpened((value) => !value)
							center.markAllRead()
						}}
					>
						<IconBell size={17} />
					</ActionIcon>
				</Indicator>
			</Popover.Target>
			<Popover.Dropdown style={{ maxWidth: 'calc(100vw - 16px)' }}>
				<Stack gap="sm">
					<Group justify="space-between">
						<Text fw={600} size="sm">
							通知历史
						</Text>
						<Button
							size="compact-xs"
							variant="subtle"
							disabled={center.items.length === 0}
							onClick={center.clear}
						>
							清空历史
						</Button>
					</Group>
					<ScrollArea.Autosize mah={320} type="auto">
						<Stack gap="xs">
							{center.items.length > 0 ? (
								center.items.map((item) => (
									<div key={item.id} className="plx-workspace__notification">
										<Text size="sm" fw={600}>
											{item.title ?? '工作台'}
										</Text>
										<Text size="xs" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
											{item.message}
										</Text>
										<Text size="xs" c="dimmed">
											{new Date(item.createdAt).toLocaleString()}
										</Text>
									</div>
								))
							) : (
								<Text c="dimmed" size="sm">
									暂无通知
								</Text>
							)}
						</Stack>
					</ScrollArea.Autosize>
					<Button
						variant="subtle"
						size="compact-xs"
						leftSection={<IconX size={13} />}
						onClick={() => setOpened(false)}
					>
						关闭
					</Button>
				</Stack>
			</Popover.Dropdown>
		</Popover>
	)
}

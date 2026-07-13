import { HotkeysProvider, useHotkey } from '@tanstack/react-hotkeys'
import { useStore } from '@tanstack/react-store'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { useMediaQuery } from '@mantine/hooks'
import {
	IconHome2,
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand,
	IconSearch,
	IconX,
} from '@tabler/icons-react'
import { startTransition, type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react'
import { ExtensionPoints, useExtensionSurface } from '../../extension'
import { ColorSchemeToggle } from '../../theme'
import { PluginCatalog } from '../plugins/catalog/PluginCatalog'
import { PLUGIN_SEARCH_EVENT } from '../constants'
import { baseNavItems, buildExtensionNavItems } from '../navigation/navConfig'
import { WorkbenchPaneControls } from '../plugins/detail/controls/WorkbenchPaneControls'
import { PluginWorkbenchLayoutProvider } from '../plugins/detail/workbench/context'
import { useCurrentPathname } from '../router/useCurrentRoute'
import { WorkbenchActionButton } from './LayoutControls'
import {
	DEFAULT_PLUGIN_SECTION_LAYOUT,
	PLUGIN_RAIL_PANEL_ID,
	PLUGIN_SECTION_CONTENT_PANEL_ID,
	PLUGIN_WORKBENCH_PANELS_SCOPE,
	WorkbenchSplitView,
	mergeLayout,
	resolvePluginWorkbenchPanelsState,
	sanitizePluginSectionLayout,
	type SplitViewHandle,
	type SplitViewPane,
	type PluginWorkbenchPanelsState,
	useSyncedLayout,
} from './split'
import {
	getWorkbenchSectionId,
	getWorkbenchSectionTitle,
	isWorkbenchActivityActive,
} from './location'
import {
	createPersistedWorkbenchState,
	getSectionPaneState,
	PLUGINS_SECTION_ID,
	WORKBENCH_STORAGE_KEY,
	type WorkbenchSectionId,
	type WorkbenchTab,
} from './state'
import {
	closeWorkbenchTab,
	pruneWorkbenchDirtyTabs,
	resetWorkbenchToHome,
	setWorkbenchActiveTabId,
	setWorkbenchActiveTabState,
	setWorkbenchSectionPaneLayout,
	setWorkbenchSectionPaneVisible,
	setWorkbenchTabDirty,
	syncWorkbenchLocation,
	toggleWorkbenchSectionPane,
	toggleWorkbenchNavigationCollapsed,
	workbenchStore,
} from './store'
import { deriveTabFromPath } from './tabs'
import {
	consumeWorkbenchNavigationIntent,
	queueWorkbenchNavigationIntent,
	type WorkbenchNavigationMode,
	WorkbenchLayoutProvider,
	WorkbenchTabsProvider,
} from './context'
import { WORKBENCH_HOTKEYS, WORKBENCH_HOTKEY_LABELS } from './shortcuts'
import './styles.scss'

const PLUGIN_PATH_PATTERN = /^\/plugins\/([^/]+)/
const EMPTY_TAB_STATE: Record<string, unknown> = {}
type WorkbenchActivityItem = {
	exact?: boolean
	href: string
	icon?: ReactNode
	label: string
}

function resolvePluginNameFromPath(pathname: string) {
	const match = pathname.match(PLUGIN_PATH_PATTERN)
	if (!match?.[1]) return undefined
	try {
		return decodeURIComponent(match[1])
	} catch {
		return match[1]
	}
}

function dispatchPluginSearchEvent() {
	if (typeof window === 'undefined') return
	window.setTimeout(() => {
		window.dispatchEvent(
			new CustomEvent<string | undefined>(PLUGIN_SEARCH_EVENT, { detail: undefined }),
		)
	}, 0)
}

function WorkbenchHotkeys({
	canTogglePluginRail,
	onCloseActiveTab,
	onFocusSearch,
	onNextTab,
	onPrevTab,
	onTogglePluginRail,
}: {
	canTogglePluginRail: boolean
	onCloseActiveTab: () => void
	onFocusSearch: () => void
	onNextTab: () => void
	onPrevTab: () => void
	onTogglePluginRail: () => void
}): null {
	useHotkey(
		WORKBENCH_HOTKEYS.togglePluginRail,
		() => {
			if (!canTogglePluginRail) return
			onTogglePluginRail()
		},
		{ ignoreInputs: true, preventDefault: true },
	)
	useHotkey(
		WORKBENCH_HOTKEYS.focusSearch,
		() => {
			onFocusSearch()
		},
		{ ignoreInputs: true, preventDefault: true },
	)
	useHotkey(
		WORKBENCH_HOTKEYS.closeActiveTab,
		() => {
			onCloseActiveTab()
		},
		{ ignoreInputs: true, preventDefault: true },
	)
	useHotkey(
		WORKBENCH_HOTKEYS.prevTab as never,
		() => {
			onPrevTab()
		},
		{ ignoreInputs: true, preventDefault: true },
	)
	useHotkey(
		WORKBENCH_HOTKEYS.nextTab as never,
		() => {
			onNextTab()
		},
		{ ignoreInputs: true, preventDefault: true },
	)
	return null
}

function StatusBar({ surface }: { surface: { hasFill: boolean; nodes: ReactNode[] } }) {
	if (!surface.hasFill) return null
	return <div className="plx-workbench__statusbar">{surface.nodes}</div>
}

function ActivityRail({
	activityItems,
	collapsed,
	onToggleCollapsed,
	pathname,
	requestNavigation,
}: {
	activityItems: WorkbenchActivityItem[]
	collapsed: boolean
	onToggleCollapsed: () => void
	pathname: string
	requestNavigation: (to: string, request?: WorkbenchNavigationMode | 'auto') => string
}) {
	return (
		<aside className="plx-workbench__activity" aria-label="工作台导航">
			<div className="plx-workbench__activityBrand">
				<ColorSchemeToggle
					label="切换工作台明暗模式"
					variant="subtle"
					size={34}
					radius="sm"
					className="plx-workbench__activityBrandMark"
				/>
				<span className="plx-workbench__activityBrandText">
					<strong>Pluxel</strong>
					<small>点击图标切换主题</small>
				</span>
			</div>

			<nav className="plx-workbench__activityList">
				{activityItems.map((item) => {
					const isActive = isWorkbenchActivityActive(pathname, item.href, item.exact)
					return (
						<Link
							key={`${item.href}:${item.label}`}
							to={item.href}
							className="plx-workbench__activityItem"
							onClick={() => {
								requestNavigation(item.href, 'auto')
							}}
							data-active={isActive ? 'true' : 'false'}
							aria-current={isActive ? 'page' : undefined}
							title={item.label}
						>
							<span className="plx-workbench__activityIcon" aria-hidden="true">
								{item.icon ?? <IconHome2 size={18} stroke={1.7} />}
							</span>
							<span className="plx-workbench__activityLabel">{item.label}</span>
						</Link>
					)
				})}
			</nav>

			<div className="plx-workbench__activityFooter">
				<button
					type="button"
					className="plx-workbench__navigationToggle"
					onClick={onToggleCollapsed}
					aria-label={collapsed ? '展开主导航' : '收起主导航为仅图标'}
					title={collapsed ? '展开主导航' : '收起为仅图标'}
				>
					{collapsed ? (
						<IconLayoutSidebarLeftExpand size={18} stroke={1.7} />
					) : (
						<IconLayoutSidebarLeftCollapse size={18} stroke={1.7} />
					)}
					<span>{collapsed ? '展开导航' : '仅显示图标'}</span>
				</button>
			</div>
		</aside>
	)
}

function PluginTopbarActions({
	focusWorkbenchSearch,
	isPluginDetail,
	togglePluginNav,
}: {
	focusWorkbenchSearch: () => void
	isPluginDetail: boolean
	togglePluginNav: () => void
}) {
	return (
		<>
			{isPluginDetail ? (
				<WorkbenchActionButton
					className="plx-workbench__action"
					label="插件列表"
					onClick={togglePluginNav}
					title={`切换插件列表 (${WORKBENCH_HOTKEY_LABELS.togglePluginRail})`}
				>
					<IconLayoutSidebarLeftCollapse size={16} stroke={1.8} />
					<span className="plx-workbench__actionLabel">插件列表</span>
					<span className="plx-workbench__actionHint">
						{WORKBENCH_HOTKEY_LABELS.togglePluginRail}
					</span>
				</WorkbenchActionButton>
			) : null}

			<WorkbenchActionButton
				className="plx-workbench__action"
				label="打开插件"
				onClick={focusWorkbenchSearch}
				title={`打开插件搜索 (${WORKBENCH_HOTKEY_LABELS.focusSearch})`}
			>
				<IconSearch size={16} stroke={1.8} />
				<span className="plx-workbench__actionLabel">打开插件</span>
				<span className="plx-workbench__actionHint">{WORKBENCH_HOTKEY_LABELS.focusSearch}</span>
			</WorkbenchActionButton>

			{isPluginDetail ? <WorkbenchPaneControls /> : null}
		</>
	)
}

function EditorTabStrip({
	activeTabId,
	dirtyTabs,
	onActivateTab,
	onCloseTab,
	tabs,
}: {
	activeTabId: string | null
	dirtyTabs: Record<string, boolean>
	onActivateTab: (tab: WorkbenchTab) => void
	onCloseTab: (tabId: string) => void
	tabs: WorkbenchTab[]
}) {
	return (
		<div className="plx-workbench__editorTabStrip" role="tablist" aria-label="工作标签页">
			{tabs.map((tab) => {
				const isActive = tab.id === activeTabId
				const isDirty = Boolean(dirtyTabs[tab.id])
				return (
					<div
						key={tab.id}
						className="plx-workbench__editorTabButton"
						data-active={isActive ? 'true' : 'false'}
						role="tab"
						aria-selected={isActive}
						tabIndex={0}
						onClick={() => onActivateTab(tab)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault()
								onActivateTab(tab)
							}
						}}
					>
						<div className="plx-workbench__editorTabBody">
							<span className="plx-workbench__editorTabTitle">{tab.title}</span>
							{isDirty ? (
								<span
									className="plx-workbench__editorTabDirtyDot"
									title="未保存更改"
									aria-hidden="true"
								/>
							) : null}
							{tab.meta ? <span className="plx-workbench__editorTabMeta">{tab.meta}</span> : null}
						</div>
						<button
							type="button"
							className="plx-workbench__iconButton"
							aria-label={`关闭 ${tab.title}`}
							onClick={(event) => {
								event.stopPropagation()
								onCloseTab(tab.id)
							}}
						>
							<IconX size={14} stroke={1.8} />
						</button>
					</div>
				)
			})}
		</div>
	)
}

function PluginNavigationRail({
	onCollapse,
	pluginName,
}: {
	onCollapse: () => void
	pluginName?: string
}) {
	return (
		<div className="plx-workbench__navigationRail">
			<div className="plx-workbench__navigationBody">
				<PluginCatalog pluginName={pluginName} onCollapse={onCollapse} />
			</div>
		</div>
	)
}

function WorkspacePaneContent() {
	return (
		<div className="plx-workbench__workspace">
			<div className="plx-workbench__workspaceContent">
				<Outlet />
			</div>
		</div>
	)
}

function WorkbenchStatePersistence(): null {
	const uiState = useStore(workbenchStore, (state) => state.uiState)

	useEffect(() => {
		if (typeof window === 'undefined') return undefined
		const persist = () => {
			try {
				window.localStorage.setItem(
					WORKBENCH_STORAGE_KEY,
					JSON.stringify(createPersistedWorkbenchState(uiState)),
				)
			} catch {}
		}
		if (typeof window.requestIdleCallback === 'function') {
			const handle = window.requestIdleCallback(persist, { timeout: 240 })
			return () => window.cancelIdleCallback(handle)
		}
		const handle = window.setTimeout(persist, 120)
		return () => window.clearTimeout(handle)
	}, [uiState])

	return null
}

export function WorkbenchShell() {
	const isNarrowViewport = useMediaQuery('(max-width: 47.99em)')
	const pathname = useCurrentPathname()
	const navigate = useNavigate()
	const pluginLayoutGroupRef = useRef<SplitViewHandle | null>(null)
	const navbarSurface = useExtensionSurface(ExtensionPoints.NavbarItems, { renderNodes: false })
	const statusBarSurface = useExtensionSurface(ExtensionPoints.GlobalStatusBar)
	const currentTab = deriveTabFromPath(pathname)
	const currentSection = getWorkbenchSectionId(pathname)
	const pluginName = resolvePluginNameFromPath(pathname)
	const isPluginsSection = currentSection === PLUGINS_SECTION_ID
	const tabs = useStore(workbenchStore, (state) => state.uiState.tabs)
	const activeTabId = useStore(workbenchStore, (state) => state.uiState.activeTabId)
	const navigationCollapsed = useStore(workbenchStore, (state) => state.uiState.navigationCollapsed)
	const sectionPanes = useStore(workbenchStore, (state) => state.uiState.sectionPanes)
	const dirtyTabs = useStore(workbenchStore, (state) => state.dirtyTabs)
	const showTabStrip = tabs.length > 1

	useEffect(() => {
		const intent = consumeWorkbenchNavigationIntent(pathname)
		syncWorkbenchLocation(pathname, intent?.mode ?? 'replace-active')
	}, [pathname])

	useEffect(() => {
		pruneWorkbenchDirtyTabs()
	}, [tabs])

	const extensionNavItems = useMemo(() => {
		if (navbarSurface.items.length === 0) return []
		return buildExtensionNavItems(
			navbarSurface.items.map(({ meta }) => ({
				id: meta.id,
				label: typeof meta.label === 'string' ? meta.label : undefined,
				href: typeof meta.href === 'string' ? meta.href : undefined,
				icon: meta.icon,
				rightSection: meta.rightSection,
				exact: meta.exact === true,
			})),
		).filter((item) => typeof item.href === 'string' && item.href !== '#')
	}, [navbarSurface.items])

	const activityItems = useMemo(() => [...baseNavItems, ...extensionNavItems], [extensionNavItems])
	const sectionTitle = getWorkbenchSectionTitle(pathname)
	const activeTab = useMemo(
		() => tabs.find((tab) => tab.id === activeTabId) ?? currentTab,
		[activeTabId, currentTab, tabs],
	)
	const resolvedActiveTabId = activeTabId ?? currentTab.id
	const activeTabStateMap = useStore(workbenchStore, (state) =>
		resolvedActiveTabId
			? (state.uiState.tabState[resolvedActiveTabId] ?? EMPTY_TAB_STATE)
			: EMPTY_TAB_STATE,
	)
	const activeTabDirty = Boolean(activeTab?.id && dirtyTabs[activeTab.id])
	const currentSectionPane = useMemo(
		() => (isPluginsSection ? getSectionPaneState({ sectionPanes }, PLUGINS_SECTION_ID) : null),
		[isPluginsSection, sectionPanes],
	)
	const isPluginDetail = isPluginsSection && Boolean(pluginName)
	useSyncedLayout(
		pluginLayoutGroupRef,
		currentSectionPane?.layout ?? DEFAULT_PLUGIN_SECTION_LAYOUT,
		isPluginDetail && Boolean(currentSectionPane),
	)
	const showPluginNav = isPluginDetail && Boolean(currentSectionPane?.visible)
	const activePluginWorkbenchLayout = useMemo(
		() => resolvePluginWorkbenchPanelsState(activeTabStateMap[PLUGIN_WORKBENCH_PANELS_SCOPE]),
		[activeTabStateMap],
	)
	const { dockVisible, rightPaneVisible } = activePluginWorkbenchLayout

	const setSectionPaneVisible = useCallback((sectionId: WorkbenchSectionId, visible: boolean) => {
		setWorkbenchSectionPaneVisible(sectionId, visible)
	}, [])
	const toggleSectionPane = useCallback((sectionId: WorkbenchSectionId) => {
		toggleWorkbenchSectionPane(sectionId)
	}, [])
	const setActivePluginWorkbenchLayout = useCallback(
		(nextValue: Partial<PluginWorkbenchPanelsState>) => {
			const tabId = workbenchStore.state.uiState.activeTabId ?? currentTab.id
			const currentState = resolvePluginWorkbenchPanelsState(
				workbenchStore.state.uiState.tabState[tabId]?.[PLUGIN_WORKBENCH_PANELS_SCOPE],
			)
			const nextState = { ...currentState, ...nextValue }
			if (
				nextState.rightPaneVisible === currentState.rightPaneVisible &&
				nextState.dockVisible === currentState.dockVisible
			) {
				return
			}
			setWorkbenchActiveTabState(tabId, PLUGIN_WORKBENCH_PANELS_SCOPE, nextState)
		},
		[currentTab.id],
	)
	const setDockVisibleDeferred = useCallback(
		(visible: boolean) => {
			startTransition(() => {
				setActivePluginWorkbenchLayout({ dockVisible: visible })
			})
		},
		[setActivePluginWorkbenchLayout],
	)
	const setRightPaneVisibleDeferred = useCallback(
		(visible: boolean) => {
			startTransition(() => {
				setActivePluginWorkbenchLayout({ rightPaneVisible: visible })
			})
		},
		[setActivePluginWorkbenchLayout],
	)
	const toggleDockDeferred = useCallback(() => {
		startTransition(() => {
			setActivePluginWorkbenchLayout({ dockVisible: !activePluginWorkbenchLayout.dockVisible })
		})
	}, [activePluginWorkbenchLayout.dockVisible, setActivePluginWorkbenchLayout])
	const toggleRightPaneDeferred = useCallback(() => {
		startTransition(() => {
			setActivePluginWorkbenchLayout({
				rightPaneVisible: !activePluginWorkbenchLayout.rightPaneVisible,
			})
		})
	}, [activePluginWorkbenchLayout.rightPaneVisible, setActivePluginWorkbenchLayout])

	const openPluginWorkspace = useCallback(
		(mode: 'open-tab' | 'replace-active') => {
			setSectionPaneVisible(PLUGINS_SECTION_ID, true)
			queueWorkbenchNavigationIntent({ to: '/plugins', mode })
			if (!pathname.startsWith('/plugins')) {
				navigate({ to: '/plugins' })
			}
			dispatchPluginSearchEvent()
		},
		[navigate, pathname, setSectionPaneVisible],
	)
	const focusWorkbenchSearch = useCallback(() => {
		openPluginWorkspace('replace-active')
	}, [openPluginWorkspace])

	const navigateToWorkbenchTab = useCallback(
		(tab: Pick<WorkbenchTab, 'id' | 'path'>) => {
			setWorkbenchActiveTabId(tab.id)
			if (tab.path === pathname) return
			startTransition(() => {
				navigate({ to: tab.path })
			})
		},
		[navigate, pathname],
	)

	const activateTab = useCallback(
		(tab: WorkbenchTab) => {
			navigateToWorkbenchTab(tab)
		},
		[navigateToWorkbenchTab],
	)
	const stepTab = useCallback(
		(direction: 1 | -1) => {
			const { tabs: storeTabs, activeTabId: storeActiveTabId } = workbenchStore.state.uiState
			if (storeTabs.length <= 1) return
			const activeIndex = storeTabs.findIndex((tab) => tab.id === storeActiveTabId)
			const nextIndex =
				activeIndex === -1 ? 0 : (activeIndex + direction + storeTabs.length) % storeTabs.length
			const nextTab = storeTabs[nextIndex]
			if (!nextTab) return
			navigateToWorkbenchTab(nextTab)
		},
		[navigateToWorkbenchTab],
	)

	const closeTab = useCallback(
		(tabId: string) => {
			const { tabs: storeTabs, activeTabId: storeActiveTabId } = workbenchStore.state.uiState
			if (dirtyTabs[tabId]) {
				const tab = storeTabs.find((item) => item.id === tabId)
				const confirmed = window.confirm(
					`"${tab?.title ?? '当前标签页'}" 还有未保存更改，确定关闭吗？`,
				)
				if (!confirmed) return
			}
			if (storeTabs.length <= 1) {
				resetWorkbenchToHome()
				navigate({ to: '/' })
				return
			}
			const index = storeTabs.findIndex((tab) => tab.id === tabId)
			if (index === -1) return
			const nextTabs = storeTabs.filter((tab) => tab.id !== tabId)
			const closingActive = storeActiveTabId === tabId
			const fallbackTab =
				nextTabs[Math.max(0, index - 1)] ??
				nextTabs[Math.min(index, nextTabs.length - 1)] ??
				nextTabs[0]
			closeWorkbenchTab(tabId)
			if (closingActive && fallbackTab) {
				navigateToWorkbenchTab(fallbackTab)
			}
		},
		[dirtyTabs, navigate, navigateToWorkbenchTab],
	)

	const togglePluginNav = useCallback(() => {
		toggleSectionPane(PLUGINS_SECTION_ID)
	}, [toggleSectionPane])
	const previousMobilePluginRef = useRef<string | undefined>(undefined)

	useEffect(() => {
		if (!isNarrowViewport || !isPluginDetail) return
		const previousPlugin = previousMobilePluginRef.current
		previousMobilePluginRef.current = pluginName
		if (pluginName && pluginName !== previousPlugin) {
			setSectionPaneVisible(PLUGINS_SECTION_ID, false)
		}
	}, [isNarrowViewport, isPluginDetail, pluginName, setSectionPaneVisible])

	const handleLayoutChanged = useCallback(
		(layout: Record<string, number>) => {
			setWorkbenchSectionPaneLayout(
				PLUGINS_SECTION_ID,
				mergeLayout(
					currentSectionPane?.layout ?? DEFAULT_PLUGIN_SECTION_LAYOUT,
					layout,
					sanitizePluginSectionLayout,
				),
			)
		},
		[currentSectionPane?.layout],
	)
	const pluginRailPane = useMemo<SplitViewPane>(
		() => ({
			id: PLUGIN_RAIL_PANEL_ID,
			defaultSize:
				currentSectionPane?.layout[PLUGIN_RAIL_PANEL_ID] ??
				DEFAULT_PLUGIN_SECTION_LAYOUT[PLUGIN_RAIL_PANEL_ID],
			minSize: 14,
			snap: true,
			visible: showPluginNav,
			onVisibleChange: (visible: boolean) => {
				setSectionPaneVisible(PLUGINS_SECTION_ID, visible)
			},
			children: <PluginNavigationRail onCollapse={togglePluginNav} pluginName={pluginName} />,
		}),
		[currentSectionPane?.layout, pluginName, setSectionPaneVisible, showPluginNav, togglePluginNav],
	)
	const workspacePane = useMemo<SplitViewPane>(
		() => ({
			id: PLUGIN_SECTION_CONTENT_PANEL_ID,
			defaultSize:
				currentSectionPane?.layout[PLUGIN_SECTION_CONTENT_PANEL_ID] ??
				DEFAULT_PLUGIN_SECTION_LAYOUT[PLUGIN_SECTION_CONTENT_PANEL_ID],
			minSize: 56,
			children: <WorkspacePaneContent />,
		}),
		[currentSectionPane?.layout],
	)
	const mobileSinglePane = isNarrowViewport && isPluginDetail
	const primaryPane = !isPluginDetail
		? workspacePane
		: mobileSinglePane
			? showPluginNav
				? pluginRailPane
				: workspacePane
			: pluginRailPane
	const secondaryPane = !isPluginDetail || mobileSinglePane ? undefined : workspacePane
	const layoutContextValue = useMemo(
		() => ({
			leftPaneAvailable: isPluginDetail,
			leftPaneVisible: showPluginNav,
			setLeftPaneVisible: (visible: boolean) => {
				setSectionPaneVisible(PLUGINS_SECTION_ID, visible)
			},
			toggleLeftPane: togglePluginNav,
		}),
		[isPluginDetail, setSectionPaneVisible, showPluginNav, togglePluginNav],
	)
	const pluginWorkbenchLayoutValue = useMemo(
		() => ({
			rightPaneVisible,
			setRightPaneVisible: setRightPaneVisibleDeferred,
			toggleRightPane: toggleRightPaneDeferred,
			dockVisible,
			setDockVisible: setDockVisibleDeferred,
			toggleDock: toggleDockDeferred,
		}),
		[
			dockVisible,
			rightPaneVisible,
			setDockVisibleDeferred,
			setRightPaneVisibleDeferred,
			toggleDockDeferred,
			toggleRightPaneDeferred,
		],
	)
	const isTabDirty = useCallback(
		(tabId: string | null) => Boolean(tabId && dirtyTabs[tabId]),
		[dirtyTabs],
	)
	const getActiveTabState = useCallback(
		<T = unknown,>(scope: string) => {
			if (!scope) return undefined
			return activeTabStateMap[scope] as T | undefined
		},
		[activeTabStateMap],
	)
	const setActiveTabState = useCallback(
		(scope: string, value: unknown) => {
			setWorkbenchActiveTabState(resolvedActiveTabId, scope, value)
		},
		[resolvedActiveTabId],
	)
	const setActiveTabDirty = useCallback(
		(dirty: boolean) => {
			setWorkbenchTabDirty(resolvedActiveTabId, dirty)
		},
		[resolvedActiveTabId],
	)
	const workbenchTabsValue = useMemo(
		() => ({
			activeTabId: activeTab?.id ?? null,
			activeTabPath: activeTab?.path ?? null,
			activeTabDirty,
			isTabDirty,
			getActiveTabState,
			setActiveTabState,
			requestNavigation: (to: string, request: WorkbenchNavigationMode | 'auto' = 'auto') => {
				const mode =
					request === 'auto'
						? activeTabDirty && activeTab?.path !== to
							? 'open-tab'
							: 'replace-active'
						: request
				if (activeTab?.path !== to) queueWorkbenchNavigationIntent({ to, mode })
				return mode
			},
			setActiveTabDirty,
		}),
		[
			activeTab,
			activeTabDirty,
			getActiveTabState,
			isTabDirty,
			setActiveTabDirty,
			setActiveTabState,
		],
	)

	return (
		<HotkeysProvider defaultOptions={{ hotkey: { ignoreInputs: true } }}>
			<WorkbenchTabsProvider value={workbenchTabsValue}>
				<WorkbenchLayoutProvider value={layoutContextValue}>
					<PluginWorkbenchLayoutProvider value={pluginWorkbenchLayoutValue}>
						<div
							className="plx-workbench"
							data-navigation-collapsed={navigationCollapsed ? 'true' : 'false'}
						>
							<WorkbenchHotkeys
								canTogglePluginRail={isPluginsSection}
								onCloseActiveTab={() =>
									closeTab(workbenchStore.state.uiState.activeTabId ?? currentTab.id)
								}
								onFocusSearch={focusWorkbenchSearch}
								onNextTab={() => stepTab(1)}
								onPrevTab={() => stepTab(-1)}
								onTogglePluginRail={togglePluginNav}
							/>

							<ActivityRail
								activityItems={activityItems}
								collapsed={navigationCollapsed}
								onToggleCollapsed={toggleWorkbenchNavigationCollapsed}
								pathname={pathname}
								requestNavigation={workbenchTabsValue.requestNavigation}
							/>

							<div className="plx-workbench__main" data-has-tabs={showTabStrip ? 'true' : 'false'}>
								<header
									className="plx-workbench__topbar"
									data-compact={isPluginDetail ? 'true' : 'false'}
								>
									<div className="plx-workbench__topbarTitle">
										<span className="plx-workbench__eyebrow">{sectionTitle.eyebrow}</span>
										<span className="plx-workbench__title">{sectionTitle.title}</span>
										{activeTabDirty && !showTabStrip ? (
											<span className="plx-workbench__editorTabDirtyDot" title="未保存更改" />
										) : null}
										{sectionTitle.subtitle ? (
											<span className="plx-workbench__subtitle">{sectionTitle.subtitle}</span>
										) : null}
									</div>

									<div className="plx-workbench__topbarActions">
										{isPluginsSection ? (
											<PluginTopbarActions
												focusWorkbenchSearch={focusWorkbenchSearch}
												isPluginDetail={isPluginDetail}
												togglePluginNav={togglePluginNav}
											/>
										) : null}
										<ColorSchemeToggle
											label="切换工作台明暗模式"
											variant="subtle"
											size="md"
											radius="sm"
											className="plx-workbench__mobileThemeToggle"
										/>
									</div>
								</header>

								{showTabStrip ? (
									<EditorTabStrip
										activeTabId={activeTabId}
										dirtyTabs={dirtyTabs}
										onActivateTab={activateTab}
										onCloseTab={closeTab}
										tabs={tabs}
									/>
								) : null}

								<div className="plx-workbench__body">
									<div className="plx-workbench__surface">
										<WorkbenchSplitView
											className="plx-workbench__panelGroup"
											defaultLayout={currentSectionPane?.layout ?? DEFAULT_PLUGIN_SECTION_LAYOUT}
											id="pluxel-workbench-main"
											onLayoutChanged={handleLayoutChanged}
											orientation="horizontal"
											primary={primaryPane}
											secondary={secondaryPane}
											ref={pluginLayoutGroupRef}
										/>
									</div>
								</div>

								<StatusBar surface={statusBarSurface} />
								<WorkbenchStatePersistence />
							</div>
						</div>
					</PluginWorkbenchLayoutProvider>
				</WorkbenchLayoutProvider>
			</WorkbenchTabsProvider>
		</HotkeysProvider>
	)
}

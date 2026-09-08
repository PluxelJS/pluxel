import { useMediaQuery } from '@mantine/hooks'
import { formatPluginNodeRoute } from '@pluxel/core'
import { HotkeysProvider } from '@tanstack/react-hotkeys'
import { useStore } from '@tanstack/react-store'
import { useNavigate } from '@tanstack/react-router'
import { startTransition, useCallback, useEffect, useMemo, useRef } from 'react'
import { buildWorkbenchHref, parsePluginDetailHref } from '../../workbench/paths'
import { useWorkbenchNavigationRoutes } from '../../workbench/runtime'
import { PLUGIN_SEARCH_EVENT } from '../constants'
import { baseNavItems, buildWorkbenchNavItems, groupNavItems } from '../navigation/navConfig'
import { PluginWorkbenchLayoutProvider } from '../plugins/detail/workbench/context'
import { useCurrentPathname } from '../router/useCurrentRoute'
import { settleBrowserNavigation } from '../router/navigationResult'
import {
	WorkbenchLayoutProvider,
	WorkbenchNavigationProvider,
	useWorkspaceController,
} from './context'
import {
	isPluginWorkbenchLocation,
	isWorkbenchActivityActive,
	resolveWorkbenchLocation,
} from './location'
import {
	DEFAULT_PLUGIN_SECTION_LAYOUT,
	PLUGIN_RAIL_PANEL_ID,
	PLUGIN_SECTION_CONTENT_PANEL_ID,
	WorkbenchSplitView,
	mergeLayout,
	sanitizePluginSectionLayout,
	type SplitViewHandle,
	type SplitViewPane,
	useSyncedLayout,
} from './split'
import {
	ActivityRail,
	PluginNavigationRail,
	PluginQuickOpenAction,
	RouteGroupRail,
	WorkbenchHotkeys,
	WorkbenchTopbarTools,
} from './shell/WorkbenchShellViews'
import { RemotePaneLayoutControls } from './RemotePaneLayoutControls'
import { WorkbenchStatePersistence } from './shell/WorkbenchStatePersistence'
import { WorkspaceEditorGrid } from './shell/WorkspaceEditorGrid'
import { WorkbenchUpdateStatus } from './shell/WorkbenchUpdateStatus'
import './styles.scss'

function resolvePluginRouteFromPath(pathname: string) {
	const parsed = parsePluginDetailHref(pathname)
	return parsed ? formatPluginNodeRoute(parsed.target) : undefined
}

function dispatchPluginSearchEvent() {
	if (typeof window === 'undefined') return
	window.setTimeout(() => {
		window.dispatchEvent(
			new CustomEvent<string | undefined>(PLUGIN_SEARCH_EVENT, { detail: undefined }),
		)
	}, 0)
}

export function WorkbenchShell() {
	const workspace = useWorkspaceController()
	const isNarrowViewport = Boolean(useMediaQuery('(max-width: 47.99em)'))
	const pathname = useCurrentPathname()
	const navigate = useNavigate()
	const pluginLayoutGroupRef = useRef<SplitViewHandle | null>(null)
	const navigationRoutes = useWorkbenchNavigationRoutes()
	const currentLocation = useMemo(() => resolveWorkbenchLocation(pathname), [pathname])
	const pluginRoute = resolvePluginRouteFromPath(pathname)
	const isPluginsSection = isPluginWorkbenchLocation(pathname)
	const tabs = useStore(workspace.store, (state) => state.uiState.tabs)
	const activeGroupId = useStore(workspace.store, (state) => state.uiState.editor.activeGroupId)
	const editorGroups = useStore(workspace.store, (state) => state.uiState.editor.groups)
	const activeTabId = useStore(workspace.store, (state) => {
		const group = state.uiState.editor.groups.find(
			(item) => item.id === state.uiState.editor.activeGroupId,
		)
		return group?.activeTabId ?? null
	})
	const navigationCollapsed = useStore(
		workspace.store,
		(state) => state.uiState.navigationCollapsed,
	)
	const pluginPane = useStore(workspace.store, (state) => state.uiState.pluginPane)
	const dirtyTabs = useStore(workspace.store, (state) => state.dirtyTabs)
	const activeTab = useMemo(
		() => tabs.find((tab) => tab.instanceId === activeTabId),
		[activeTabId, tabs],
	)

	useEffect(() => {
		workspace.reconcileLocation(pathname)
	}, [pathname, workspace])

	const workbenchNavItems = useMemo(() => {
		if (navigationRoutes.length === 0) return []
		return buildWorkbenchNavItems(
			navigationRoutes.map((entry) => {
				const route = entry.placement.kind === 'route' ? entry.placement : undefined
				return {
					id: entry.descriptor.key,
					label: route?.navigation?.label ?? route?.title,
					href: route ? buildWorkbenchHref(entry.target.node, route.path, route.frame) : undefined,
					icon: route?.icon,
					group: route?.navigation?.group,
				}
			}),
		).filter((item) => typeof item.href === 'string' && item.href !== '#')
	}, [navigationRoutes])

	const activityItems = useMemo(
		() => groupNavItems([...baseNavItems, ...workbenchNavItems]),
		[workbenchNavItems],
	)
	const activeRouteGroup = useMemo(
		() =>
			activityItems.find((item) =>
				item.children?.some((child) =>
					isWorkbenchActivityActive(pathname, child.href, child.exact),
				),
			),
		[activityItems, pathname],
	)
	const activeRouteGroupItem = activeRouteGroup?.children?.find((item) =>
		isWorkbenchActivityActive(pathname, item.href, item.exact),
	)
	const sectionTitle = activeRouteGroup
		? {
				eyebrow: 'Workbench',
				title: activeRouteGroup.label,
				subtitle: activeRouteGroupItem?.label,
			}
		: currentLocation.header
	const currentPluginPane = isPluginsSection ? pluginPane : null
	const isPluginDetail = isPluginsSection && Boolean(pluginRoute)
	useSyncedLayout(
		pluginLayoutGroupRef,
		currentPluginPane?.layout ?? DEFAULT_PLUGIN_SECTION_LAYOUT,
		isPluginDetail && Boolean(currentPluginPane),
	)
	const showPluginNav = isPluginDetail && Boolean(currentPluginPane?.visible)

	const setPluginPaneVisible = useCallback(
		(visible: boolean) => workspace.setPluginPaneVisible(visible),
		[workspace],
	)
	const togglePluginPane = useCallback(() => workspace.togglePluginPane(), [workspace])
	const commitBrowserNavigation = useCallback(
		(to: string) => {
			if (pathname === to) return
			startTransition(() => {
				settleBrowserNavigation(navigate({ to }))
			})
		},
		[navigate, pathname],
	)
	const navigateToRoute = useCallback(
		(to: string) => {
			if (activeTab?.path === to && pathname === to) return
			workspace.requestNavigation(to)
			commitBrowserNavigation(to)
		},
		[activeTab?.path, commitBrowserNavigation, pathname, workspace],
	)
	const openTab = useCallback(
		(input: { path: string; title: string; meta?: string }) => {
			workspace.openTab(input)
			commitBrowserNavigation(input.path)
		},
		[commitBrowserNavigation, workspace],
	)

	const openPluginWorkspace = useCallback(() => {
		setPluginPaneVisible(true)
		if (!pathname.startsWith('/plugins')) navigateToRoute('/plugins')
		dispatchPluginSearchEvent()
	}, [navigateToRoute, pathname, setPluginPaneVisible])
	const focusWorkbenchSearch = useCallback(() => openPluginWorkspace(), [openPluginWorkspace])
	const togglePluginNav = useCallback(() => togglePluginPane(), [togglePluginPane])
	const previousMobilePluginRef = useRef<string | undefined>(undefined)

	useEffect(() => {
		if (!isNarrowViewport || !isPluginDetail) return
		const previousPlugin = previousMobilePluginRef.current
		previousMobilePluginRef.current = pluginRoute
		if (pluginRoute && pluginRoute !== previousPlugin) setPluginPaneVisible(false)
	}, [isNarrowViewport, isPluginDetail, pluginRoute, setPluginPaneVisible])

	const navigateToActiveTab = useCallback(() => {
		const tab = workspace.activeTab
		if (tab) commitBrowserNavigation(tab.path)
	}, [commitBrowserNavigation, workspace])
	const closeActiveTab = useCallback(() => {
		const tab = workspace.activeTab
		if (!tab) return
		if (dirtyTabs[tab.instanceId]) {
			const confirmed = window.confirm(`"${tab.title}" 还有未保存更改，确定关闭吗？`)
			if (!confirmed) return
		}
		workspace.closeTab(tab.instanceId)
		navigateToActiveTab()
	}, [dirtyTabs, navigateToActiveTab, workspace])
	const stepTab = useCallback(
		(direction: 1 | -1) => {
			const state = workspace.state.uiState
			const group = state.editor.groups.find((item) => item.id === state.editor.activeGroupId)
			if (!group || group.tabIds.length <= 1) return
			const activeIndex = group.tabIds.indexOf(group.activeTabId)
			const nextIndex =
				activeIndex === -1
					? 0
					: (activeIndex + direction + group.tabIds.length) % group.tabIds.length
			const nextTabId = group.tabIds[nextIndex]
			if (!nextTabId) return
			workspace.activateTab(group.id, nextTabId)
			navigateToActiveTab()
		},
		[navigateToActiveTab, workspace],
	)
	const cycleEditorGroup = useCallback(() => {
		if (editorGroups.length <= 1) return
		const currentIndex = editorGroups.findIndex((group) => group.id === activeGroupId)
		const nextGroup = editorGroups[(currentIndex + 1 + editorGroups.length) % editorGroups.length]
		if (!nextGroup) return
		workspace.focusGroup(nextGroup.id)
		navigateToActiveTab()
	}, [activeGroupId, editorGroups, navigateToActiveTab, workspace])

	const handleLayoutChanged = useCallback(
		(layout: Record<string, number>) => {
			workspace.setPluginPaneLayout(
				mergeLayout(
					currentPluginPane?.layout ?? DEFAULT_PLUGIN_SECTION_LAYOUT,
					layout,
					sanitizePluginSectionLayout,
				),
			)
		},
		[currentPluginPane?.layout, workspace],
	)
	const pluginRailPane = useMemo<SplitViewPane>(
		() => ({
			id: PLUGIN_RAIL_PANEL_ID,
			defaultSizePercent:
				currentPluginPane?.layout[PLUGIN_RAIL_PANEL_ID] ??
				DEFAULT_PLUGIN_SECTION_LAYOUT[PLUGIN_RAIL_PANEL_ID],
			minSizePercent: 14,
			snap: true,
			visible: showPluginNav,
			onVisibleChange: setPluginPaneVisible,
			children: <PluginNavigationRail onCollapse={togglePluginNav} pluginRoute={pluginRoute} />,
		}),
		[currentPluginPane?.layout, pluginRoute, setPluginPaneVisible, showPluginNav, togglePluginNav],
	)
	const workspacePane = useMemo<SplitViewPane>(
		() => ({
			id: PLUGIN_SECTION_CONTENT_PANEL_ID,
			defaultSizePercent:
				currentPluginPane?.layout[PLUGIN_SECTION_CONTENT_PANEL_ID] ??
				DEFAULT_PLUGIN_SECTION_LAYOUT[PLUGIN_SECTION_CONTENT_PANEL_ID],
			minSizePercent: 56,
			children: (
				<WorkspaceEditorGrid
					isNarrowViewport={isNarrowViewport}
					navigate={commitBrowserNavigation}
					pathname={pathname}
				/>
			),
		}),
		[currentPluginPane?.layout, commitBrowserNavigation, isNarrowViewport, pathname],
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
			setLeftPaneVisible: (visible: boolean) => setPluginPaneVisible(visible),
			toggleLeftPane: togglePluginNav,
		}),
		[isPluginDetail, setPluginPaneVisible, showPluginNav, togglePluginNav],
	)
	const workbenchNavigationValue = useMemo(
		() => ({ navigate: navigateToRoute, openTab }),
		[navigateToRoute, openTab],
	)

	return (
		<HotkeysProvider defaultOptions={{ hotkey: { ignoreInputs: true } }}>
			<WorkbenchNavigationProvider value={workbenchNavigationValue}>
				<WorkbenchLayoutProvider value={layoutContextValue}>
					<PluginWorkbenchLayoutProvider>
						<div
							className="plx-workbench"
							data-navigation-collapsed={navigationCollapsed ? 'true' : 'false'}
							data-has-route-group={activeRouteGroup ? 'true' : 'false'}
						>
							<WorkbenchHotkeys
								canTogglePluginRail={isPluginsSection}
								onCloseActiveTab={closeActiveTab}
								onFocusSearch={focusWorkbenchSearch}
								onNextTab={() => stepTab(1)}
								onPrevTab={() => stepTab(-1)}
								onTogglePluginRail={togglePluginNav}
							/>

							<ActivityRail
								activityItems={activityItems}
								collapsed={navigationCollapsed}
								onToggleCollapsed={() => workspace.toggleNavigationCollapsed()}
								pathname={pathname}
							/>

							{activeRouteGroup ? (
								<RouteGroupRail group={activeRouteGroup} pathname={pathname} />
							) : null}

							<div className="plx-workbench__main">
								<header
									className="plx-workbench__topbar"
									data-compact={isPluginDetail ? 'true' : 'false'}
								>
									<div className="plx-workbench__topbarLeading">
										<div className="plx-workbench__topbarTitle">
											<span className="plx-workbench__eyebrow">{sectionTitle.eyebrow}</span>
											<span className="plx-workbench__title">{sectionTitle.title}</span>
											{sectionTitle.subtitle ? (
												<span className="plx-workbench__subtitle">{sectionTitle.subtitle}</span>
											) : null}
										</div>
										<WorkbenchTopbarTools
											isPluginDetail={isPluginDetail}
											remotePaneControls={
												<RemotePaneLayoutControls
													registry={workspace.paneLayoutControls}
													tabId={activeTabId}
												/>
											}
										/>
									</div>

									<div className="plx-workbench__topbarActions">
										<WorkbenchUpdateStatus />
										{editorGroups.length > 1 ? (
											<button
												className="plx-workbench__editorGroupSwitcher"
												onClick={cycleEditorGroup}
												title="切换到下一个编辑组"
												type="button"
											>
												编辑组 {editorGroups.findIndex((group) => group.id === activeGroupId) + 1}/
												{editorGroups.length}
											</button>
										) : null}
										{isPluginsSection ? (
											<PluginQuickOpenAction focusWorkbenchSearch={focusWorkbenchSearch} />
										) : null}
									</div>
								</header>

								<div className="plx-workbench__body">
									<div className="plx-workbench__surface">
										<WorkbenchSplitView
											className="plx-workbench__panelGroup"
											layout={currentPluginPane?.layout ?? DEFAULT_PLUGIN_SECTION_LAYOUT}
											id="pluxel-workbench-main"
											onLayoutCommit={handleLayoutChanged}
											orientation="horizontal"
											panes={secondaryPane ? [primaryPane, secondaryPane] : [primaryPane]}
											ref={pluginLayoutGroupRef}
										/>
									</div>
								</div>

								<WorkbenchStatePersistence controller={workspace} />
							</div>
						</div>
					</PluginWorkbenchLayoutProvider>
				</WorkbenchLayoutProvider>
			</WorkbenchNavigationProvider>
		</HotkeysProvider>
	)
}

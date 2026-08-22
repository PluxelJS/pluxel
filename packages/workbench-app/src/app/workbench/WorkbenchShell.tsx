import { HotkeysProvider } from '@tanstack/react-hotkeys'
import { useStore } from '@tanstack/react-store'
import { useNavigate } from '@tanstack/react-router'
import { useMediaQuery } from '@mantine/hooks'
import { formatPluginNodeRoute } from '@pluxel/core'
import { startTransition, useCallback, useEffect, useMemo, useRef } from 'react'
import { buildWorkbenchHref, parsePluginDetailHref } from '../../workbench/paths'
import { useWorkbenchNavigationRoutes } from '../../workbench/runtime'
import { PLUGIN_SEARCH_EVENT } from '../constants'
import { baseNavItems, buildWorkbenchNavItems, groupNavItems } from '../navigation/navConfig'
import { PluginWorkbenchLayoutProvider } from '../plugins/detail/workbench/context'
import { useCurrentPathname } from '../router/useCurrentRoute'
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
	isPluginWorkbenchLocation,
	isWorkbenchActivityActive,
	resolveWorkbenchLocation,
} from './location'
import type { WorkbenchTab } from './state'
import {
	WorkbenchLayoutProvider,
	WorkbenchNavigationProvider,
	useWorkspaceController,
} from './context'
import {
	ActivityRail,
	EditorTabStrip,
	PluginNavigationRail,
	PluginTopbarActions,
	RouteGroupRail,
	WorkbenchHotkeys,
	WorkspacePaneContent,
} from './shell/WorkbenchShellViews'
import { WorkbenchStatePersistence } from './shell/WorkbenchStatePersistence'
import './styles.scss'

const EMPTY_TAB_STATE: Record<string, unknown> = {}
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
	const isNarrowViewport = useMediaQuery('(max-width: 47.99em)')
	const pathname = useCurrentPathname()
	const navigate = useNavigate()
	const pluginLayoutGroupRef = useRef<SplitViewHandle | null>(null)
	const navigationRoutes = useWorkbenchNavigationRoutes()
	const currentLocation = useMemo(() => resolveWorkbenchLocation(pathname), [pathname])
	const pluginRoute = resolvePluginRouteFromPath(pathname)
	const isPluginsSection = isPluginWorkbenchLocation(pathname)
	const tabs = useStore(workspace.store, (state) => state.uiState.tabs)
	const activeTabId = useStore(workspace.store, (state) => state.uiState.activeTabId)
	const navigationCollapsed = useStore(
		workspace.store,
		(state) => state.uiState.navigationCollapsed,
	)
	const pluginPane = useStore(workspace.store, (state) => state.uiState.pluginPane)
	const dirtyTabs = useStore(workspace.store, (state) => state.dirtyTabs)
	const showTabStrip = tabs.length > 0

	useEffect(() => {
		workspace.reconcileLocation(pathname)
	}, [pathname, workspace])

	const workbenchNavItems = useMemo(() => {
		if (navigationRoutes.length === 0) return []
		return buildWorkbenchNavItems(
			navigationRoutes.map((item) => {
				const route = item.meta?.route
				return {
					id: item.id,
					label: route?.navigationLabel ?? route?.title,
					href: route
						? buildWorkbenchHref(item.target.address, route.path, route.frame ?? 'shell')
						: undefined,
					icon: route?.icon,
					group: route?.navigationGroup,
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
	const activeTab = useMemo(
		() => tabs.find((tab) => tab.instanceId === activeTabId),
		[activeTabId, tabs],
	)
	const resolvedActiveTabId = activeTab?.instanceId ?? null
	const activeTabStateMap = useStore(workspace.store, (state) =>
		resolvedActiveTabId
			? (state.uiState.tabState[resolvedActiveTabId] ?? EMPTY_TAB_STATE)
			: EMPTY_TAB_STATE,
	)
	const currentPluginPane = isPluginsSection ? pluginPane : null
	const isPluginDetail = isPluginsSection && Boolean(pluginRoute)
	useSyncedLayout(
		pluginLayoutGroupRef,
		currentPluginPane?.layout ?? DEFAULT_PLUGIN_SECTION_LAYOUT,
		isPluginDetail && Boolean(currentPluginPane),
	)
	const showPluginNav = isPluginDetail && Boolean(currentPluginPane?.visible)
	const activePluginWorkbenchLayout = useMemo(
		() => resolvePluginWorkbenchPanelsState(activeTabStateMap[PLUGIN_WORKBENCH_PANELS_SCOPE]),
		[activeTabStateMap],
	)
	const { dockVisible, rightPaneVisible } = activePluginWorkbenchLayout

	const setPluginPaneVisible = useCallback(
		(visible: boolean) => workspace.setPluginPaneVisible(visible),
		[workspace],
	)
	const togglePluginPane = useCallback(() => workspace.togglePluginPane(), [workspace])
	const setActivePluginWorkbenchLayout = useCallback(
		(nextValue: Partial<PluginWorkbenchPanelsState>) => {
			const tabId = workspace.state.uiState.activeTabId
			if (!tabId) return
			const currentState = resolvePluginWorkbenchPanelsState(
				workspace.state.uiState.tabState[tabId]?.[PLUGIN_WORKBENCH_PANELS_SCOPE],
			)
			const nextState = { ...currentState, ...nextValue }
			if (
				nextState.rightPaneVisible === currentState.rightPaneVisible &&
				nextState.dockVisible === currentState.dockVisible
			) {
				return
			}
			workspace.setActiveTabState(tabId, PLUGIN_WORKBENCH_PANELS_SCOPE, nextState)
		},
		[workspace],
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
	const navigateToRoute = useCallback(
		(to: string) => {
			if (activeTab?.path === to || pathname === to) return
			workspace.requestNavigation(to)
			startTransition(() => {
				void navigate({ to })
			})
		},
		[activeTab?.path, navigate, pathname, workspace],
	)

	const openPluginWorkspace = useCallback(() => {
		setPluginPaneVisible(true)
		if (!pathname.startsWith('/plugins')) {
			navigateToRoute('/plugins')
		}
		dispatchPluginSearchEvent()
	}, [navigateToRoute, pathname, setPluginPaneVisible])
	const focusWorkbenchSearch = useCallback(() => {
		openPluginWorkspace()
	}, [openPluginWorkspace])

	const navigateToWorkbenchTab = useCallback(
		(tab: Pick<WorkbenchTab, 'instanceId' | 'path'>) => {
			workspace.setActiveTabId(tab.instanceId)
			if (tab.path === pathname) return
			startTransition(() => {
				void navigate({ to: tab.path })
			})
		},
		[navigate, pathname, workspace],
	)
	const openTab = useCallback(
		(input: { path: string; title: string; meta?: string }) => {
			workspace.openTab(input)
			if (input.path === pathname) return
			startTransition(() => {
				void navigate({ to: input.path })
			})
		},
		[navigate, pathname, workspace],
	)

	const activateTab = useCallback(
		(tab: WorkbenchTab) => {
			navigateToWorkbenchTab(tab)
		},
		[navigateToWorkbenchTab],
	)
	const stepTab = useCallback(
		(direction: 1 | -1) => {
			const { tabs: storeTabs, activeTabId: storeActiveTabId } = workspace.state.uiState
			if (storeTabs.length <= 1) return
			const activeIndex = storeTabs.findIndex((tab) => tab.instanceId === storeActiveTabId)
			const nextIndex =
				activeIndex === -1 ? 0 : (activeIndex + direction + storeTabs.length) % storeTabs.length
			const nextTab = storeTabs[nextIndex]
			if (!nextTab) return
			navigateToWorkbenchTab(nextTab)
		},
		[navigateToWorkbenchTab, workspace],
	)

	const closeTab = useCallback(
		(tabId: string) => {
			const { tabs: storeTabs, activeTabId: storeActiveTabId } = workspace.state.uiState
			if (dirtyTabs[tabId]) {
				const tab = storeTabs.find((item) => item.instanceId === tabId)
				const confirmed = window.confirm(
					`"${tab?.title ?? '当前标签页'}" 还有未保存更改，确定关闭吗？`,
				)
				if (!confirmed) return
			}
			const closingActive = storeActiveTabId === tabId
			const nextTab = workspace.closeTab(tabId)
			if (closingActive && nextTab) {
				navigateToWorkbenchTab(nextTab)
			}
		},
		[dirtyTabs, navigateToWorkbenchTab, workspace],
	)
	const addWorkbenchTab = useCallback(() => {
		workspace.createAdjacentTab()
	}, [workspace])

	const togglePluginNav = useCallback(() => {
		togglePluginPane()
	}, [togglePluginPane])
	const previousMobilePluginRef = useRef<string | undefined>(undefined)

	useEffect(() => {
		if (!isNarrowViewport || !isPluginDetail) return
		const previousPlugin = previousMobilePluginRef.current
		previousMobilePluginRef.current = pluginRoute
		if (pluginRoute && pluginRoute !== previousPlugin) {
			setPluginPaneVisible(false)
		}
	}, [isNarrowViewport, isPluginDetail, pluginRoute, setPluginPaneVisible])

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
			children: <WorkspacePaneContent tabId={resolvedActiveTabId} />,
		}),
		[currentPluginPane?.layout, resolvedActiveTabId],
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
				setPluginPaneVisible(visible)
			},
			toggleLeftPane: togglePluginNav,
		}),
		[isPluginDetail, setPluginPaneVisible, showPluginNav, togglePluginNav],
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
	const workbenchNavigationValue = useMemo(
		() => ({
			navigate: navigateToRoute,
			openTab,
		}),
		[navigateToRoute, openTab],
	)

	return (
		<HotkeysProvider defaultOptions={{ hotkey: { ignoreInputs: true } }}>
			<WorkbenchNavigationProvider value={workbenchNavigationValue}>
				<WorkbenchLayoutProvider value={layoutContextValue}>
					<PluginWorkbenchLayoutProvider value={pluginWorkbenchLayoutValue}>
						<div
							className="plx-workbench"
							data-navigation-collapsed={navigationCollapsed ? 'true' : 'false'}
							data-has-route-group={activeRouteGroup ? 'true' : 'false'}
						>
							<WorkbenchHotkeys
								canTogglePluginRail={isPluginsSection}
								onCloseActiveTab={() => {
									const tabId = workspace.state.uiState.activeTabId
									if (tabId) closeTab(tabId)
								}}
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

							<div className="plx-workbench__main" data-has-tabs={showTabStrip ? 'true' : 'false'}>
								<header
									className="plx-workbench__topbar"
									data-compact={isPluginDetail ? 'true' : 'false'}
								>
									<div className="plx-workbench__topbarTitle">
										<span className="plx-workbench__eyebrow">{sectionTitle.eyebrow}</span>
										<span className="plx-workbench__title">{sectionTitle.title}</span>
										{sectionTitle.subtitle ? (
											<span className="plx-workbench__subtitle">{sectionTitle.subtitle}</span>
										) : null}
									</div>

									{isPluginsSection ? (
										<div className="plx-workbench__topbarActions">
											<PluginTopbarActions
												focusWorkbenchSearch={focusWorkbenchSearch}
												isPluginDetail={isPluginDetail}
												togglePluginNav={togglePluginNav}
											/>
										</div>
									) : null}
								</header>

								{showTabStrip ? (
									<EditorTabStrip
										activeTabId={activeTabId}
										dirtyTabs={dirtyTabs}
										onActivateTab={activateTab}
										onAddTab={addWorkbenchTab}
										onCloseTab={closeTab}
										tabs={tabs}
									/>
								) : null}

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

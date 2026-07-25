import { HotkeysProvider } from '@tanstack/react-hotkeys'
import { useStore } from '@tanstack/react-store'
import { useNavigate } from '@tanstack/react-router'
import { useMediaQuery } from '@mantine/hooks'
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildWorkbenchHref } from '../../workbench/paths'
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
	getWorkbenchSectionId,
	getWorkbenchSectionTitle,
	isWorkbenchActivityActive,
} from './location'
import {
	getSectionPaneState,
	PLUGINS_SECTION_ID,
	type WorkbenchSectionId,
	type WorkbenchTab,
} from './state'
import { WorkspaceController } from './store'
import { deriveTabFromPath } from './tabs'
import {
	type WorkbenchNavigationMode,
	WorkbenchLayoutProvider,
	WorkbenchTabsProvider,
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

const PLUGIN_PATH_PATTERN = /^\/plugins\/([^/]+)/
const EMPTY_TAB_STATE: Record<string, unknown> = {}
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

export function WorkbenchShell() {
	const [workspace] = useState(() => new WorkspaceController())
	const isNarrowViewport = useMediaQuery('(max-width: 47.99em)')
	const pathname = useCurrentPathname()
	const navigate = useNavigate()
	const pluginLayoutGroupRef = useRef<SplitViewHandle | null>(null)
	const navigationRoutes = useWorkbenchNavigationRoutes()
	const currentTab = deriveTabFromPath(pathname)
	const currentSection = getWorkbenchSectionId(pathname)
	const pluginName = resolvePluginNameFromPath(pathname)
	const isPluginsSection = currentSection === PLUGINS_SECTION_ID
	const tabs = useStore(workspace.store, (state) => state.uiState.tabs)
	const activeTabId = useStore(workspace.store, (state) => state.uiState.activeTabId)
	const navigationCollapsed = useStore(
		workspace.store,
		(state) => state.uiState.navigationCollapsed,
	)
	const sectionPanes = useStore(workspace.store, (state) => state.uiState.sectionPanes)
	const dirtyTabs = useStore(workspace.store, (state) => state.dirtyTabs)
	const showTabStrip = tabs.length > 0

	useEffect(() => {
		const intent = workspace.consumeNavigation(pathname)
		workspace.syncLocation(pathname, intent?.mode ?? 'replace-active')
	}, [pathname, workspace])

	useEffect(() => {
		workspace.pruneDirtyTabs()
	}, [tabs, workspace])

	const workbenchNavItems = useMemo(() => {
		if (navigationRoutes.length === 0) return []
		return buildWorkbenchNavItems(
			navigationRoutes.map((item) => {
				const route = item.meta?.route
				return {
					id: item.id,
					label: route?.navigationLabel ?? route?.title,
					href: route
						? buildWorkbenchHref(item.targetPluginId, route.path, route.frame ?? 'shell')
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
		: getWorkbenchSectionTitle(pathname)
	const activeTab = useMemo(
		() => tabs.find((tab) => tab.id === activeTabId) ?? currentTab,
		[activeTabId, currentTab, tabs],
	)
	const resolvedActiveTabId = activeTabId ?? currentTab.id
	const activeTabStateMap = useStore(workspace.store, (state) =>
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

	const setSectionPaneVisible = useCallback(
		(sectionId: WorkbenchSectionId, visible: boolean) => {
			workspace.setSectionPaneVisible(sectionId, visible)
		},
		[workspace],
	)
	const toggleSectionPane = useCallback(
		(sectionId: WorkbenchSectionId) => {
			workspace.toggleSectionPane(sectionId)
		},
		[workspace],
	)
	const setActivePluginWorkbenchLayout = useCallback(
		(nextValue: Partial<PluginWorkbenchPanelsState>) => {
			const tabId = workspace.state.uiState.activeTabId ?? currentTab.id
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
		[currentTab.id, workspace],
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
			workspace.queueNavigation('/plugins', mode)
			if (!pathname.startsWith('/plugins')) {
				void navigate({ to: '/plugins' })
			}
			dispatchPluginSearchEvent()
		},
		[navigate, pathname, setSectionPaneVisible, workspace],
	)
	const focusWorkbenchSearch = useCallback(() => {
		openPluginWorkspace('replace-active')
	}, [openPluginWorkspace])

	const navigateToWorkbenchTab = useCallback(
		(tab: Pick<WorkbenchTab, 'id' | 'path'>) => {
			workspace.setActiveTabId(tab.id)
			if (tab.path === pathname) return
			startTransition(() => {
				void navigate({ to: tab.path })
			})
		},
		[navigate, pathname, workspace],
	)
	const openTab = useCallback(
		(input: { to: string; title: string; meta?: string }) => {
			workspace.openTab({ path: input.to, title: input.title, meta: input.meta })
			if (input.to === pathname) return
			workspace.queueNavigation(input.to, 'open-tab')
			startTransition(() => {
				void navigate({ to: input.to })
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
			const activeIndex = storeTabs.findIndex((tab) => tab.id === storeActiveTabId)
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
				const tab = storeTabs.find((item) => item.id === tabId)
				const confirmed = window.confirm(
					`"${tab?.title ?? '当前标签页'}" 还有未保存更改，确定关闭吗？`,
				)
				if (!confirmed) return
			}
			if (storeTabs.length <= 1) {
				workspace.resetToHome()
				void navigate({ to: '/' })
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
			workspace.closeTab(tabId)
			if (closingActive && fallbackTab) {
				navigateToWorkbenchTab(fallbackTab)
			}
		},
		[dirtyTabs, navigate, navigateToWorkbenchTab, workspace],
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
			workspace.setSectionPaneLayout(
				PLUGINS_SECTION_ID,
				mergeLayout(
					currentSectionPane?.layout ?? DEFAULT_PLUGIN_SECTION_LAYOUT,
					layout,
					sanitizePluginSectionLayout,
				),
			)
		},
		[currentSectionPane?.layout, workspace],
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
			workspace.setActiveTabState(resolvedActiveTabId, scope, value)
		},
		[resolvedActiveTabId, workspace],
	)
	const setActiveTabDirty = useCallback(
		(dirty: boolean) => {
			workspace.setTabDirty(resolvedActiveTabId, dirty)
		},
		[resolvedActiveTabId, workspace],
	)
	const workbenchTabsValue = useMemo(
		() => ({
			activeTabId: activeTab?.id ?? null,
			activeTabPath: activeTab?.path ?? null,
			activeTabDirty,
			isTabDirty,
			getActiveTabState,
			openTab,
			setActiveTabState,
			requestNavigation: (to: string, request: WorkbenchNavigationMode | 'auto' = 'auto') => {
				const mode =
					request === 'auto'
						? activeTabDirty && activeTab?.path !== to
							? 'open-tab'
							: 'replace-active'
						: request
				if (activeTab?.path !== to) workspace.queueNavigation(to, mode)
				return mode
			},
			setActiveTabDirty,
		}),
		[
			activeTab,
			activeTabDirty,
			getActiveTabState,
			isTabDirty,
			openTab,
			setActiveTabDirty,
			setActiveTabState,
			workspace,
		],
	)

	return (
		<HotkeysProvider defaultOptions={{ hotkey: { ignoreInputs: true } }}>
			<WorkbenchTabsProvider controller={workspace} value={workbenchTabsValue}>
				<WorkbenchLayoutProvider value={layoutContextValue}>
					<PluginWorkbenchLayoutProvider value={pluginWorkbenchLayoutValue}>
						<div
							className="plx-workbench"
							data-navigation-collapsed={navigationCollapsed ? 'true' : 'false'}
							data-has-route-group={activeRouteGroup ? 'true' : 'false'}
						>
							<WorkbenchHotkeys
								canTogglePluginRail={isPluginsSection}
								onCloseActiveTab={() =>
									closeTab(workspace.state.uiState.activeTabId ?? currentTab.id)
								}
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
								requestNavigation={workbenchTabsValue.requestNavigation}
							/>

							{activeRouteGroup ? (
								<RouteGroupRail
									group={activeRouteGroup}
									pathname={pathname}
									openTab={openTab}
									requestNavigation={workbenchTabsValue.requestNavigation}
								/>
							) : null}

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
										onCloseTab={closeTab}
										tabs={tabs}
									/>
								) : null}

								<div className="plx-workbench__body">
									<div className="plx-workbench__surface">
										<WorkbenchSplitView
											className="plx-workbench__panelGroup"
											layout={currentSectionPane?.layout ?? DEFAULT_PLUGIN_SECTION_LAYOUT}
											id="pluxel-workbench-main"
											onLayoutCommit={handleLayoutChanged}
											orientation="horizontal"
											primary={primaryPane}
											secondary={secondaryPane}
											ref={pluginLayoutGroupRef}
										/>
									</div>
								</div>

								<WorkbenchStatePersistence controller={workspace} />
							</div>
						</div>
					</PluginWorkbenchLayoutProvider>
				</WorkbenchLayoutProvider>
			</WorkbenchTabsProvider>
		</HotkeysProvider>
	)
}

import { HotkeysProvider, useHotkey } from '@tanstack/react-hotkeys'
import { useStore } from '@tanstack/react-store'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import {
	IconBox,
	IconChevronLeft,
	IconHome2,
	IconLayoutSidebarLeftCollapse,
	IconSearch,
	IconX,
} from '@tabler/icons-react'
import {
	Group as PanelGroup,
	type GroupImperativeHandle,
	Panel,
	Separator as PanelSeparator,
} from 'react-resizable-panels'
import { startTransition, type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react'
import { ExtensionPoints, useExtensionSurface } from '../../extension'
import { ColorSchemeToggle } from '../../theme'
import { PluginList } from '../plugins/list'
import { PLUGIN_SEARCH_EVENT } from '../constants'
import { baseNavItems, buildExtensionNavItems } from '../navigation/navConfig'
import { WorkbenchPaneControls } from '../plugins/detail/components'
import { PluginWorkbenchLayoutProvider } from '../plugins/detail/workbench/context'
import { useCurrentPathname } from '../router/useCurrentRoute'
import {
	DEFAULT_PLUGIN_SECTION_LAYOUT,
	PLUGIN_RAIL_PANEL_ID,
	PLUGIN_SECTION_CONTENT_PANEL_ID,
	resolvePluginWorkbenchPanelsState,
	type PluginWorkbenchPanelsState,
} from './pluginLayout'
import {
	getWorkbenchSectionId,
	getWorkbenchSectionTitle,
	isWorkbenchActivityActive,
} from './location'
import { hasSameLayout } from './storage'
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
	setWorkbenchPluginWorkbenchPanelsState,
	setWorkbenchSectionPaneLayout,
	setWorkbenchSectionPaneVisible,
	setWorkbenchTabDirty,
	syncWorkbenchLocation,
	toggleWorkbenchSectionPane,
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
import './styles.scss'
const PANEL_STYLE = {
	display: 'flex',
	flexDirection: 'column' as const,
	height: '100%',
	minHeight: 0,
	minWidth: 0,
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
		'Mod+B',
		() => {
			if (!canTogglePluginRail) return
			onTogglePluginRail()
		},
		{ ignoreInputs: true, preventDefault: true },
	)
	useHotkey(
		'Mod+K',
		() => {
			onFocusSearch()
		},
		{ ignoreInputs: true, preventDefault: true },
	)
	useHotkey(
		'Mod+W',
		() => {
			onCloseActiveTab()
		},
		{ ignoreInputs: true, preventDefault: true },
	)
	useHotkey(
		'Mod+Shift+BracketLeft' as never,
		() => {
			onPrevTab()
		},
		{ ignoreInputs: true, preventDefault: true },
	)
	useHotkey(
		'Mod+Shift+BracketRight' as never,
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

export function WorkbenchShell() {
	const pathname = useCurrentPathname()
	const navigate = useNavigate()
	const pluginLayoutGroupRef = useRef<GroupImperativeHandle | null>(null)
	const navbarSurface = useExtensionSurface(ExtensionPoints.NavbarItems, { renderNodes: false })
	const statusBarSurface = useExtensionSurface(ExtensionPoints.GlobalStatusBar)
	const currentTab = useMemo(() => deriveTabFromPath(pathname), [pathname])
	const currentSection = useMemo(() => getWorkbenchSectionId(pathname), [pathname])
	const pluginName = useMemo(() => {
		const match = pathname.match(/^\/plugins\/([^/]+)/)
		if (!match?.[1]) return undefined
		try {
			return decodeURIComponent(match[1])
		} catch {
			return match[1]
		}
	}, [pathname])
	const uiState = useStore(workbenchStore, (state) => state.uiState)
	const dirtyTabs = useStore(workbenchStore, (state) => state.dirtyTabs)

	useEffect(() => {
		const intent = consumeWorkbenchNavigationIntent(pathname)
		syncWorkbenchLocation(pathname, intent?.mode ?? 'replace-active')
	}, [pathname])

	useEffect(() => {
		pruneWorkbenchDirtyTabs()
	}, [uiState.tabs])

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
	const sectionTitle = useMemo(() => getWorkbenchSectionTitle(pathname), [pathname])
	const activeTab = useMemo(
		() => uiState.tabs.find((tab) => tab.id === uiState.activeTabId) ?? currentTab,
		[currentTab, uiState.activeTabId, uiState.tabs],
	)
	const resolvedActiveTabId = uiState.activeTabId ?? currentTab.id
	const activeTabStateMap = useMemo(
		() => (resolvedActiveTabId ? (uiState.tabState[resolvedActiveTabId] ?? {}) : {}),
		[resolvedActiveTabId, uiState.tabState],
	)
	const activeTabDirty = Boolean(activeTab?.id && dirtyTabs[activeTab.id])
	const currentSectionPane = useMemo(
		() =>
			currentSection === PLUGINS_SECTION_ID
				? getSectionPaneState(uiState, PLUGINS_SECTION_ID)
				: null,
		[currentSection, uiState.sectionPanes],
	)
	useEffect(() => {
		if (currentSection !== PLUGINS_SECTION_ID || !currentSectionPane) return
		const current = pluginLayoutGroupRef.current?.getLayout()
		if (!current || !hasSameLayout(current, currentSectionPane.layout)) {
			pluginLayoutGroupRef.current?.setLayout(currentSectionPane.layout)
		}
	}, [currentSection, currentSectionPane])
	const showPluginNav =
		currentSection === PLUGINS_SECTION_ID && Boolean(currentSectionPane?.visible)
	const isPluginDetail = currentSection === PLUGINS_SECTION_ID && Boolean(pluginName)
	const activePluginWorkbenchLayout = useMemo(
		() => resolvePluginWorkbenchPanelsState(uiState.tabState, activeTab?.id ?? currentTab.id),
		[activeTab?.id, currentTab.id, uiState.tabState],
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
			setWorkbenchPluginWorkbenchPanelsState(
				workbenchStore.state.uiState.activeTabId ?? currentTab.id,
				nextValue,
			)
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

	const focusWorkbenchSearch = useCallback(() => {
		setSectionPaneVisible(PLUGINS_SECTION_ID, true)
		if (!pathname.startsWith('/plugins')) {
			navigate({ to: '/plugins' })
		}
		if (typeof window !== 'undefined') {
			window.setTimeout(() => {
				window.dispatchEvent(
					new CustomEvent<string | undefined>(PLUGIN_SEARCH_EVENT, { detail: undefined }),
				)
			}, 0)
		}
	}, [navigate, pathname, setSectionPaneVisible])

	const activateTab = useCallback(
		(tab: WorkbenchTab) => {
			setWorkbenchActiveTabId(tab.id)
			startTransition(() => {
				navigate({ to: tab.path })
			})
		},
		[navigate],
	)

	const stepTab = useCallback(
		(direction: 1 | -1) => {
			const { tabs, activeTabId } = workbenchStore.state.uiState
			if (tabs.length <= 1) return
			const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId)
			const nextIndex =
				activeIndex === -1 ? 0 : (activeIndex + direction + tabs.length) % tabs.length
			const nextTab = tabs[nextIndex]
			if (!nextTab) return
			setWorkbenchActiveTabId(nextTab.id)
			startTransition(() => {
				navigate({ to: nextTab.path })
			})
		},
		[navigate],
	)

	const closeTab = useCallback(
		(tabId: string) => {
			const { tabs, activeTabId } = workbenchStore.state.uiState
			if (dirtyTabs[tabId]) {
				const tab = tabs.find((item) => item.id === tabId)
				const confirmed = window.confirm(
					`"${tab?.title ?? '当前标签页'}" 还有未保存更改，确定关闭吗？`,
				)
				if (!confirmed) return
			}
			if (tabs.length <= 1) {
				resetWorkbenchToHome()
				navigate({ to: '/' })
				return
			}
			const index = tabs.findIndex((tab) => tab.id === tabId)
			if (index === -1) return
			const nextTabs = tabs.filter((tab) => tab.id !== tabId)
			const closingActive = activeTabId === tabId
			const fallbackTab =
				nextTabs[Math.max(0, index - 1)] ??
				nextTabs[Math.min(index, nextTabs.length - 1)] ??
				nextTabs[0]
			closeWorkbenchTab(tabId)
			if (closingActive && fallbackTab) {
				startTransition(() => {
					navigate({ to: fallbackTab.path })
				})
			}
		},
		[dirtyTabs, navigate],
	)

	const togglePluginNav = useCallback(() => {
		toggleSectionPane(PLUGINS_SECTION_ID)
	}, [toggleSectionPane])

	const handleLayoutChanged = useCallback((layout: Record<string, number>) => {
		setWorkbenchSectionPaneLayout(PLUGINS_SECTION_ID, layout)
	}, [])
	const layoutContextValue = useMemo(
		() => ({
			leftPaneAvailable: currentSection === PLUGINS_SECTION_ID,
			leftPaneVisible: showPluginNav,
			setLeftPaneVisible: (visible: boolean) => {
				setSectionPaneVisible(PLUGINS_SECTION_ID, visible)
			},
			toggleLeftPane: togglePluginNav,
		}),
		[currentSection, setSectionPaneVisible, showPluginNav, togglePluginNav],
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
		<T = unknown>(scope: string) => {
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
				queueWorkbenchNavigationIntent({ to, mode })
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
						<div className="plx-workbench">
							<WorkbenchHotkeys
								canTogglePluginRail={currentSection === PLUGINS_SECTION_ID}
								onCloseActiveTab={() =>
									closeTab(workbenchStore.state.uiState.activeTabId ?? currentTab.id)
								}
								onFocusSearch={focusWorkbenchSearch}
								onNextTab={() => stepTab(1)}
								onPrevTab={() => stepTab(-1)}
								onTogglePluginRail={togglePluginNav}
							/>

							<aside className="plx-workbench__activity" aria-label="工作台导航">
								<div className="plx-workbench__activityBrand" aria-hidden="true">
									<IconBox size={20} stroke={1.8} />
								</div>

								<nav className="plx-workbench__activityList">
									{activityItems.map((item) => (
										<Link
											key={`${item.href}:${item.label}`}
											to={item.href}
											className="plx-workbench__activityItem"
											onClick={() => {
												workbenchTabsValue.requestNavigation(item.href, 'auto')
											}}
											data-active={
												isWorkbenchActivityActive(pathname, item.href, item.exact)
													? 'true'
													: 'false'
											}
											title={item.label}
										>
											{item.icon ?? <IconHome2 size={18} stroke={1.7} />}
											<span className="plx-workbench__activityLabel">{item.label}</span>
										</Link>
									))}
								</nav>
							</aside>

							<div className="plx-workbench__main">
								<header
									className="plx-workbench__topbar"
									data-compact={isPluginDetail ? 'true' : 'false'}
								>
									<div className="plx-workbench__topbarTitle">
										<span className="plx-workbench__eyebrow">{sectionTitle.eyebrow}</span>
										<span className="plx-workbench__title">
											{isPluginDetail ? '插件工作台' : sectionTitle.title}
										</span>
										{!isPluginDetail && sectionTitle.subtitle ? (
											<span className="plx-workbench__subtitle">{sectionTitle.subtitle}</span>
										) : null}
									</div>

									<div className="plx-workbench__topbarActions">
										{currentSection === PLUGINS_SECTION_ID && !isPluginDetail ? (
											<button
												type="button"
												className="plx-workbench__action"
												onClick={togglePluginNav}
												title="切换插件列表"
											>
												<IconLayoutSidebarLeftCollapse size={16} stroke={1.8} />
												<span className="plx-workbench__actionLabel">插件列表</span>
												<span className="plx-workbench__actionHint">⌘B</span>
											</button>
										) : null}

										{isPluginDetail ? <WorkbenchPaneControls /> : null}

										<button
											type="button"
											className="plx-workbench__action"
											onClick={focusWorkbenchSearch}
											title="搜索插件"
										>
											<IconSearch size={16} stroke={1.8} />
											<span className="plx-workbench__actionLabel">搜索</span>
											<span className="plx-workbench__actionHint">⌘K</span>
										</button>

										<ColorSchemeToggle
											label="切换工作台明暗模式"
											size="md"
											radius="md"
											className="plx-workbench__themeToggle"
										/>
									</div>
								</header>

								<div
									className="plx-workbench__editorTabStrip"
									role="tablist"
									aria-label="工作标签页"
								>
									{uiState.tabs.map((tab) => {
										const isActive = tab.id === uiState.activeTabId
										const isDirty = Boolean(dirtyTabs[tab.id])
										return (
											<div
												key={tab.id}
												className="plx-workbench__editorTabButton"
												data-active={isActive ? 'true' : 'false'}
												role="tab"
												aria-selected={isActive}
												tabIndex={0}
												onClick={() => activateTab(tab)}
												onKeyDown={(event) => {
													if (event.key === 'Enter' || event.key === ' ') {
														event.preventDefault()
														activateTab(tab)
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
													{tab.meta ? (
														<span className="plx-workbench__editorTabMeta">{tab.meta}</span>
													) : null}
												</div>
												<button
													type="button"
													className="plx-workbench__iconButton"
													aria-label={`关闭 ${tab.title}`}
													onClick={(event) => {
														event.stopPropagation()
														closeTab(tab.id)
													}}
												>
													<IconX size={14} stroke={1.8} />
												</button>
											</div>
										)
									})}
								</div>

								<div className="plx-workbench__body">
									<div className="plx-workbench__surface">
										{showPluginNav ? (
											<PanelGroup
												className="plx-workbench__panelGroup"
												id="pluxel-workbench-main"
												groupRef={pluginLayoutGroupRef}
												orientation="horizontal"
												defaultLayout={
													currentSectionPane?.layout ?? DEFAULT_PLUGIN_SECTION_LAYOUT
												}
												onLayoutChanged={handleLayoutChanged}
											>
												<Panel
													id={PLUGIN_RAIL_PANEL_ID}
													defaultSize={`${
														currentSectionPane?.layout[PLUGIN_RAIL_PANEL_ID] ??
														DEFAULT_PLUGIN_SECTION_LAYOUT[PLUGIN_RAIL_PANEL_ID]
													}%`}
													minSize="14%"
													style={PANEL_STYLE}
												>
													<div className="plx-workbench__navigationRail">
														<div className="plx-workbench__navigationHeader">
															<div className="plx-workbench__navigationTitle">
																<span className="plx-workbench__eyebrow">Plugins</span>
																<span className="plx-workbench__title">插件导航</span>
																<span className="plx-workbench__subtitle">对象选择与筛选</span>
															</div>
															<button
																type="button"
																className="plx-workbench__iconButton"
																aria-label="收起插件列表"
																onClick={togglePluginNav}
															>
																<IconChevronLeft size={16} stroke={1.8} />
															</button>
														</div>
														<div className="plx-workbench__navigationBody">
															<PluginList pluginName={pluginName} />
														</div>
													</div>
												</Panel>

												<PanelSeparator
													id="pluxel-workbench-main-separator"
													className="plx-workbench__resizeHandle"
												/>

												<Panel
													id={PLUGIN_SECTION_CONTENT_PANEL_ID}
													defaultSize={`${
														currentSectionPane?.layout[PLUGIN_SECTION_CONTENT_PANEL_ID] ??
														DEFAULT_PLUGIN_SECTION_LAYOUT[PLUGIN_SECTION_CONTENT_PANEL_ID]
													}%`}
													minSize="56%"
													style={PANEL_STYLE}
												>
													<div className="plx-workbench__workspace">
														<div className="plx-workbench__workspaceContent">
															<Outlet />
														</div>
													</div>
												</Panel>
											</PanelGroup>
										) : (
											<div className="plx-workbench__workspace">
												<div className="plx-workbench__workspaceContent">
													<Outlet />
												</div>
											</div>
										)}
									</div>
								</div>

								<StatusBar surface={statusBarSurface} />
							</div>
						</div>
					</PluginWorkbenchLayoutProvider>
				</WorkbenchLayoutProvider>
			</WorkbenchTabsProvider>
		</HotkeysProvider>
	)
}

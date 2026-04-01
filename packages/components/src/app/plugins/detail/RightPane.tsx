import {
	Badge,
	Box,
	Button,
	Center,
	CopyButton,
	Group,
	Loader,
	ScrollArea,
	Stack,
	Tabs,
	Text,
	Tooltip,
} from '@mantine/core'
import { IconSettingsOff } from '@tabler/icons-react'
import { getRouteApi, useRouter } from '@tanstack/react-router'
import {
	Fragment,
	startTransition,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import type { ObjectSchema } from 'valibot'
import { EmptyState, ErrorState } from '../../../components'
import { ExtensionSlot, useExtensions } from '../../../extension'
import type { PluginConfigState } from '../../hooks'
import { RouterLinkAdapter } from '../../RouterLinkAdapter'
import type { PluginDetailSearch } from '../../router'
import { useCurrentPathname } from '../../router/useCurrentRoute'
import { PluginRouteRenderer, useResolvedPluginRoute } from '../../router/extensions'
import {
	PANE_TABS_PROPS,
	PaneTabLabel,
	getPaneTabsRootClassName,
} from '../../workbench/PaneTabs'
import {
	ConfigForm,
	ConfigLayout,
	compareSchemaKeys,
	PLUGIN_SCHEMA_GROUP,
	splitSchemaKey,
} from '../config'
import { ActionBar, DependencyList, LogLevelsCard, PluginPanel } from './components'
import { usePluginMeta, usePluginScope } from './context'
import {
	buildRightPaneSearchSyncPatch,
	buildRightPaneTabGroups,
	CONFIG_GROUP_TAB_PREFIX,
	deepEqual,
	encodeURIComponentSafe,
	formatCompactSource,
	isConfigTab,
	mergeRightPaneState,
	normalizeRestPath,
	patchPluginDetailSearch,
	readStoredPaneState,
	resolveActiveRightPaneTab,
	resolveStoredSchemaForTab,
	RIGHT_PANE_VIEW_STATE_KEY,
	type RightPaneState,
} from './rightPaneState'
import { usePluginWorkbenchLayout } from './workbench/context'
import { PluginWorkbenchTabActivityProvider } from './workbench/tabActivity'
import { useWorkbenchTabs } from '../../workbench/context'

interface RightPaneProps {
	config: PluginConfigState
	showLevelsTab?: boolean
}

const COLUMN_STYLE = {
	flex: 1,
	minHeight: 0,
	display: 'flex',
	flexDirection: 'column' as const,
}
const pluginDetailRouteApi = getRouteApi('/_workbench/plugins/$name')
const EMPTY_PLUGIN_DETAIL_SEARCH: PluginDetailSearch = {}
type NavigateFn = (options: Record<string, unknown>) => Promise<unknown>
const NOOP_NAVIGATE: NavigateFn = async () => undefined

function usePluginDetailSearch() {
	try {
		return pluginDetailRouteApi.useSearch({ structuralSharing: true })
	} catch {
		return EMPTY_PLUGIN_DETAIL_SEARCH
	}
}

function useOptionalNavigate() {
	const router = useRouter({ warn: false })
	return useCallback(
		(options: Record<string, unknown>) => {
			if (!router) return NOOP_NAVIGATE(options)
			return router.navigate(options)
		},
		[router],
	)
}

function resolveActiveSchemaKey(params: {
	activeTab: string
	resolveSchema: (value: string | undefined) => string | undefined
	schemaFromSearch?: string
	schemaKeys: string[]
	schemaKeysByConfigTab: Map<string, string[]>
	storedState: RightPaneState
}) {
	if (!isConfigTab(params.activeTab)) return ''
	const tabKeys = params.schemaKeysByConfigTab.get(params.activeTab) ?? params.schemaKeys
	if (!tabKeys.length) return ''

	const fromSearch = params.resolveSchema(params.schemaFromSearch)
	if (fromSearch && tabKeys.includes(fromSearch)) return fromSearch

	const storedTabSchema = resolveStoredSchemaForTab(params.storedState, params.activeTab, tabKeys)
	if (storedTabSchema) return storedTabSchema

	const fromState = params.resolveSchema(params.storedState.schema)
	if (fromState && tabKeys.includes(fromState)) return fromState

	return tabKeys[0] ?? ''
}

export function RightPane({ config, showLevelsTab = false }: RightPaneProps) {
	const { pluginName, isEnabled, isRunning, isSyncing } = usePluginMeta()
	const { source, knownPluginNames } = usePluginScope()
	const { rightPaneVisible } = usePluginWorkbenchLayout()
	const { activeTabId, getActiveTabState, setActiveTabState, setActiveTabDirty } =
		useWorkbenchTabs()
	const { nodes: tabNodes, items: tabItems } = useExtensions('plugin:tabs')
	const navigate = useOptionalNavigate()
	const pathname = useCurrentPathname()
	const routeSearch = usePluginDetailSearch()
	const pluginBasePath = useMemo(
		() => `/plugins/${encodeURIComponentSafe(pluginName)}`,
		[pluginName],
	)
	const pluginConfigPath = useMemo(() => `${pluginBasePath}/config`, [pluginBasePath])
	const tabGroups = useMemo(
		() => buildRightPaneTabGroups(pluginName, tabItems, tabNodes as ReactNode[]),
		[pluginName, tabItems, tabNodes],
	)
	const [configDirtyMap, setConfigDirtyMap] = useState<Record<string, boolean>>({})
	// 配置表单需要与自定义 Tab 共存：即使没有 schema，也展示一个“暂无可配置项”的稳定入口。
	const showConfigTab = true
	const readStoredState = useCallback(
		() => readStoredPaneState(getActiveTabState),
		[getActiveTabState],
	)
	const storedState = useMemo(() => readStoredState(), [readStoredState, activeTabId])
	const storedStateRef = useRef(storedState)

	const restPath = useMemo(() => {
		if (!pathname) return ''
		const match = pathname.match(/^\/plugins\/([^/]+)(.*)$/)
		if (!match) return ''
		const [, nameSegment, rest] = match
		let decodedName = nameSegment
		try {
			decodedName = decodeURIComponent(nameSegment)
		} catch {
			decodedName = nameSegment
		}
		if (decodedName !== pluginName) return ''
		return normalizeRestPath(rest)
	}, [pathname, pluginName])

	const builtinTabFromPath = useMemo(() => {
		if (restPath === '/config') return 'config'
		return undefined
	}, [restPath])
	const showRouteTab = Boolean(restPath && !builtinTabFromPath)
	const lastRestPathRef = useRef<string>('')

	const updateRouteSearch = useCallback(
		(patch: Partial<PluginDetailSearch>, target?: string) => {
			const nextSearch = patchPluginDetailSearch(routeSearch, patch)
			const to = target ?? pathname
			if (!to) return
			if (nextSearch === routeSearch && to === pathname) return
			startTransition(() => {
				navigate({
					to,
					replace: true,
					search: nextSearch as never,
				})
			})
		},
		[navigate, pathname, routeSearch],
	)

	const tabFromSearch = routeSearch.tab
	const schemaFromSearch = routeSearch.schema

	const schemaKeys = useMemo(
		() => Object.keys(config.data?.schemaMap ?? {}),
		[config.data?.schemaMap],
	)

	const schemaKeysByConfigTab = useMemo(() => {
		const map = new Map<string, string[]>()
		const all = schemaKeys.slice().sort(compareSchemaKeys)

		const hasLayout = Boolean(config.data?.layout?.length)
		if (hasLayout) {
			// cfg layout becomes the single source of truth for grouping and ordering.
			map.set('config', all)
			return map
		}

		const pluginKeys = all.filter((key) => splitSchemaKey(key).group === PLUGIN_SCHEMA_GROUP)
		map.set('config', pluginKeys)

		const byGroup = new Map<string, string[]>()
		for (const key of all) {
			const group = splitSchemaKey(key).group
			if (group === PLUGIN_SCHEMA_GROUP) continue
			const list = byGroup.get(group)
			if (list) list.push(key)
			else byGroup.set(group, [key])
		}
		for (const [group, keys] of byGroup.entries()) {
			map.set(`${CONFIG_GROUP_TAB_PREFIX}${group}`, keys)
		}

		return map
	}, [config.data?.layout, schemaKeys])

	const configGroupTabs = useMemo(() => {
		const out: Array<{ id: string; label: string }> = []
		for (const [id, keys] of schemaKeysByConfigTab.entries()) {
			if (!id.startsWith(CONFIG_GROUP_TAB_PREFIX)) continue
			if (!keys.length) continue
			out.push({ id, label: id.slice(CONFIG_GROUP_TAB_PREFIX.length) })
		}
		return out.sort((a, b) => a.label.localeCompare(b.label))
	}, [schemaKeysByConfigTab])

	const resolveTab = useCallback(
		(value: string | undefined) => {
			if (!value) return undefined
			if (value === 'logging') return showLevelsTab ? 'logging' : undefined
			if (value === 'config' && showConfigTab) return 'config'
			if (value === 'route') return showRouteTab ? 'route' : undefined
			if (value.startsWith(CONFIG_GROUP_TAB_PREFIX)) {
				return schemaKeysByConfigTab.has(value) ? value : undefined
			}
			return tabGroups.some((tab) => tab.id === value) ? value : undefined
		},
		[schemaKeysByConfigTab, showConfigTab, showLevelsTab, showRouteTab, tabGroups],
	)
	const resolveSchema = useCallback(
		(value: string | undefined) => (value && schemaKeys.includes(value) ? value : undefined),
		[schemaKeys],
	)

	const hasTabs = true

	useEffect(() => {
		storedStateRef.current = storedState
	}, [storedState])

	useEffect(() => {
		setConfigDirtyMap({})
	}, [activeTabId, pluginName])

	const hasDirtyConfig = useMemo(
		() => Object.values(configDirtyMap).some(Boolean),
		[configDirtyMap],
	)

	useEffect(() => {
		setActiveTabDirty(hasDirtyConfig)
	}, [hasDirtyConfig, setActiveTabDirty])

	const activeTab = useMemo(
		() =>
			resolveActiveRightPaneTab({
				builtinTabFromPath,
				resolveTab,
				showRouteTab,
				showConfigTab,
				showLevelsTab,
				storedTab: storedState.tab,
				tabFromSearch,
				tabGroups,
			}),
		[
			builtinTabFromPath,
			resolveTab,
			showConfigTab,
			showLevelsTab,
			showRouteTab,
			storedState.tab,
			tabFromSearch,
			tabGroups,
		],
	)

	const activeSchemaKey = useMemo(
		() =>
			resolveActiveSchemaKey({
				activeTab,
				resolveSchema,
				schemaFromSearch,
				schemaKeys,
				schemaKeysByConfigTab,
				storedState,
			}),
		[activeTab, resolveSchema, schemaFromSearch, schemaKeys, schemaKeysByConfigTab, storedState],
	)

	// If user navigates to a plugin sub-route (path changes), default the pane to "route".
	// This runs after the schema-sync effect so we don't accidentally re-inject `schema=...`
	// when switching from config -> route.
	useEffect(() => {
		if (!showRouteTab) {
			lastRestPathRef.current = ''
			return
		}
		if (!restPath) return
		if (lastRestPathRef.current === restPath) return
		lastRestPathRef.current = restPath
		updateRouteSearch({ tab: 'route', schema: undefined })
	}, [restPath, showRouteTab, updateRouteSearch])

	useEffect(() => {
		const patch = buildRightPaneSearchSyncPatch({
			activeSchemaKey,
			activeTab,
			builtinTabFromPath,
			resolveSchema,
			resolveTab,
			schemaFromSearch,
			schemaKeys,
			schemaKeysByConfigTab,
			showRouteTab,
			tabFromSearch,
		})
		if (patch) updateRouteSearch(patch)
	}, [
		activeSchemaKey,
		activeTab,
		builtinTabFromPath,
		resolveSchema,
		resolveTab,
		schemaFromSearch,
		schemaKeys,
		schemaKeysByConfigTab,
		showRouteTab,
		tabFromSearch,
		updateRouteSearch,
	])

	const persistState = useCallback(
		(next: RightPaneState) => {
			const previous = storedStateRef.current
			const merged = mergeRightPaneState(previous, next, activeTab, activeSchemaKey)
			if (deepEqual(previous, merged)) return
			storedStateRef.current = merged
			setActiveTabState(RIGHT_PANE_VIEW_STATE_KEY, merged)
		},
		[activeSchemaKey, activeTab, setActiveTabState],
	)

	const handleTabChange = useCallback(
		(value: string | null) => {
			const next = String(value ?? 'config')
			const nextSchema = (() => {
				if (!isConfigTab(next)) return undefined
				const tabKeys = schemaKeysByConfigTab.get(next) ?? []
				if (!tabKeys.length) return undefined
				const stored = resolveStoredSchemaForTab(storedState, next, tabKeys)
				if (stored) return stored
				return tabKeys[0] ?? undefined
			})()

			persistState(
				nextSchema
					? { tab: next, schema: nextSchema, schemas: { [next]: nextSchema } }
					: { tab: next },
			)
			const patch: Partial<PluginDetailSearch> = {
				tab: next,
				schema: isConfigTab(next) ? nextSchema : undefined,
			}
			const nextTarget =
				next === 'config'
					? pluginConfigPath
					: pathname === pluginConfigPath && !showRouteTab
						? pluginBasePath
						: undefined
			if (next === 'config') patch.tab = undefined
			updateRouteSearch(patch, nextTarget)
		},
		[
			pathname,
			persistState,
			pluginBasePath,
			pluginConfigPath,
			schemaKeysByConfigTab,
			showRouteTab,
			storedState.schemas,
			updateRouteSearch,
		],
	)

	const handleSchemaChangeForTab = useCallback(
		(tabId: string, nextKey: string) => {
			// Avoid inactive panels fighting the global URL/schema.
			if (activeTab !== tabId) return
			persistState({ schema: nextKey, schemas: { [tabId]: nextKey } })
			if (!isConfigTab(activeTab)) return
			updateRouteSearch({ schema: nextKey })
		},
		[activeTab, persistState, updateRouteSearch],
	)
	const handleConfigDirtyChange = useCallback((tabId: string, dirty: boolean) => {
		setConfigDirtyMap((prev) => {
			if ((prev[tabId] ?? false) === dirty) return prev
			return { ...prev, [tabId]: dirty }
		})
	}, [])

	const schemaKeyForTab = useCallback(
		(tabId: string) => {
			const tabKeys = schemaKeysByConfigTab.get(tabId) ?? []
			if (!tabKeys.length) return ''

			if (activeTab === tabId) return activeSchemaKey

			const stored = resolveStoredSchemaForTab(storedState, tabId, tabKeys)
			if (stored) return stored

			return tabKeys[0] ?? ''
		},
		[activeSchemaKey, activeTab, schemaKeysByConfigTab, storedState],
	)
	const sourceTypeLabel =
		source.kind === 'hmr' ? 'HMR' : source.kind === 'package' ? '包安装' : '未知来源'
	const sourcePreview = useMemo(
		() =>
			formatCompactSource(
				source.moduleId ?? null,
				source.packageName ?? null,
				source.version ?? null,
			),
		[source.moduleId, source.packageName, source.version],
	)
	const sourceCopyValue = source.moduleId ?? source.packageName ?? null
	const isDependencyLinkable = useMemo(() => {
		return (name: string) => {
			if (knownPluginNames.has(name)) return true
			const hash = name.lastIndexOf('#')
			return hash > 0 ? knownPluginNames.has(name.slice(0, hash)) : false
		}
	}, [knownPluginNames])

	return (
		<PluginPanel className="plx-pluginWorkbench__contentPanel" padding="xs" gap="xs">
			<Box style={COLUMN_STYLE}>
				{hasTabs ? (
					<Tabs
						{...PANE_TABS_PROPS}
						value={activeTab}
						onChange={handleTabChange}
						keepMounted
						style={COLUMN_STYLE}
						className={getPaneTabsRootClassName('toolbar')}
					>
						<div className="plx-pluginWorkbench__toolbar">
							<div className="plx-pluginWorkbench__commandBar">
								<div className="plx-pluginWorkbench__commandMeta">
									<div className="plx-pluginWorkbench__commandTitle">
										<span className="plx-pluginWorkbench__commandName">{pluginName}</span>
										<Badge
											size="sm"
											variant={source.kind === 'hmr' ? 'filled' : 'light'}
											color={
												source.kind === 'hmr'
													? 'brand'
													: source.kind === 'package'
														? 'green'
														: 'gray'
											}
										>
											{sourceTypeLabel}
										</Badge>
										<Group gap={6} wrap="wrap" className="plx-pluginWorkbench__commandBadges">
											<Badge
												size="sm"
												variant={isRunning ? 'filled' : 'light'}
												color={isRunning ? 'green' : 'gray'}
											>
												{isRunning ? '运行中' : '已停止'}
											</Badge>
											<Badge
												size="sm"
												variant={isEnabled ? 'light' : 'outline'}
												color={isEnabled ? 'brand' : 'gray'}
											>
												{isEnabled ? '已持久启用' : '未持久启用'}
											</Badge>
											{isSyncing ? (
												<Badge variant="dot" color="brand" radius="sm">
													同步中…
												</Badge>
											) : null}
										</Group>
									</div>
									{!rightPaneVisible ? (
										<div className="plx-pluginWorkbench__commandInfo">
											{sourceCopyValue ? (
												<CopyButton value={sourceCopyValue}>
													{({ copied, copy }) => (
														<Tooltip
															label={
																copied
																	? '已复制'
																	: (source.moduleId ?? source.packageName ?? '未知来源')
															}
															multiline
															maw={360}
														>
															<Button
																type="button"
																variant="subtle"
																size="compact-xs"
																className="plx-pluginWorkbench__metaChip"
																onClick={copy}
															>
																{sourcePreview}
															</Button>
														</Tooltip>
													)}
												</CopyButton>
											) : null}
											<DependencyList
												LinkComponent={RouterLinkAdapter}
												isLinkable={isDependencyLinkable}
												linkWorkbenchMode="open-tab"
											/>
										</div>
									) : null}
								</div>

								<div className="plx-pluginWorkbench__commandActions">
									<ActionBar prominent />
									<ExtensionSlot
										point="plugin:header"
										wrapper={(nodes) => (
											<Group
												gap={6}
												wrap="nowrap"
												className="plx-pluginWorkbench__headerExtensions"
											>
												{nodes}
											</Group>
										)}
										fallback={null}
									/>
								</div>
							</div>

							<div className="plx-pluginWorkbench__toolbarTabs">
								<Tabs.List className="plx-paneTabs__list" aria-label="插件工作台标签页">
									{showRouteTab ? (
										<Tabs.Tab value="route">
											<PaneTabLabel label="页面" />
										</Tabs.Tab>
									) : null}
									{showConfigTab ? (
										<Tabs.Tab value="config">
											<PaneTabLabel label="配置" />
										</Tabs.Tab>
									) : null}
									{showLevelsTab ? (
										<Tabs.Tab value="logging">
											<PaneTabLabel label="级别" />
										</Tabs.Tab>
									) : null}
									{configGroupTabs.map((tab) => (
										<Tabs.Tab key={tab.id} value={tab.id}>
											<PaneTabLabel label={tab.label} />
										</Tabs.Tab>
									))}
									{tabGroups.map((tab) => (
										<Tabs.Tab key={tab.id} value={tab.id}>
											<PaneTabLabel label={tab.label} />
										</Tabs.Tab>
									))}
								</Tabs.List>
							</div>
						</div>

						{showRouteTab ? (
							<Tabs.Panel value="route" className="plx-paneTabs__panel" style={COLUMN_STYLE}>
								<RouteContent pluginName={pluginName} restPath={restPath} />
							</Tabs.Panel>
						) : null}

						{showConfigTab ? (
							<Tabs.Panel value="config" className="plx-paneTabs__panel" style={COLUMN_STYLE}>
								<ConfigContent
									config={config}
									pluginName={pluginName}
									schemaGroup="__plugin__"
									active={activeTab === 'config'}
									activeSchemaKey={schemaKeyForTab('config')}
									onSchemaChange={(key) => handleSchemaChangeForTab('config', key)}
									onDirtyChange={(dirty) => handleConfigDirtyChange('config', dirty)}
								/>
							</Tabs.Panel>
						) : null}

						{showLevelsTab ? (
							<Tabs.Panel
								value="logging"
								className="plx-paneTabs__panel"
								style={COLUMN_STYLE}
							>
								<ScrollArea type="auto" scrollbarSize={10} offsetScrollbars style={COLUMN_STYLE}>
									<Box p="xs" style={{ minHeight: '100%' }}>
										<LogLevelsCard pluginId={pluginName} compact />
									</Box>
								</ScrollArea>
							</Tabs.Panel>
						) : null}

						{configGroupTabs.map((tab) => (
							<Tabs.Panel
								key={tab.id}
								value={tab.id}
								className="plx-paneTabs__panel"
								style={COLUMN_STYLE}
							>
								<ConfigContent
									config={config}
									pluginName={pluginName}
									schemaGroup={tab.label}
									active={activeTab === tab.id}
									activeSchemaKey={schemaKeyForTab(tab.id)}
									onSchemaChange={(key) => handleSchemaChangeForTab(tab.id, key)}
									onDirtyChange={(dirty) => handleConfigDirtyChange(tab.id, dirty)}
								/>
							</Tabs.Panel>
						))}

						{tabGroups.map((tab) => {
							const id = tab.id
							const isActive = activeTab === id
							return (
								<Tabs.Panel
									key={id}
									value={id}
									className="plx-paneTabs__panel"
									style={COLUMN_STYLE}
								>
									<PluginWorkbenchTabActivityProvider active={isActive}>
										<ScrollArea
											type="auto"
											scrollbarSize={10}
											offsetScrollbars
											style={COLUMN_STYLE}
										>
											<Box p="xs" style={{ minHeight: '100%' }}>
												<Stack gap="sm">
													{tab.nodes.map(({ key, node }) => (
														<Fragment key={key}>{node}</Fragment>
													))}
												</Stack>
											</Box>
										</ScrollArea>
									</PluginWorkbenchTabActivityProvider>
								</Tabs.Panel>
							)
						})}
					</Tabs>
				) : (
					<ConfigContent
						config={config}
						pluginName={pluginName}
						active
						activeSchemaKey={activeSchemaKey}
						onSchemaChange={(key) => handleSchemaChangeForTab('config', key)}
						onDirtyChange={(dirty) => handleConfigDirtyChange('config', dirty)}
					/>
				)}
			</Box>
		</PluginPanel>
	)
}

function ConfigContent({
	config,
	pluginName,
	schemaGroup,
	active,
	activeSchemaKey,
	onSchemaChange,
	onDirtyChange,
}: {
	config: PluginConfigState
	pluginName: string
	schemaGroup?: string
	active: boolean
	activeSchemaKey: string
	onSchemaChange: (key: string) => void
	onDirtyChange?: (dirty: boolean) => void
}) {
	const schemaMapAll = (config.data?.schemaMap ?? {}) as Record<string, ObjectSchema<any, any>>
	const savedConfigAll = (config.data?.savedConfig ?? {}) as Record<string, unknown>
	const defaultsAll = (config.data?.defaults ?? {}) as Record<string, unknown>

	const schemaMap = useMemo(() => {
		if (!schemaGroup) return schemaMapAll
		const out: Record<string, ObjectSchema<any, any>> = {}
		for (const [key, schema] of Object.entries(schemaMapAll)) {
			if (splitSchemaKey(key).group !== schemaGroup) continue
			out[key] = schema
		}
		return out
	}, [schemaGroup, schemaMapAll])

	const savedConfig = useMemo(() => {
		if (!schemaGroup) return savedConfigAll
		const out: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(savedConfigAll)) {
			if (splitSchemaKey(key).group !== schemaGroup) continue
			out[key] = value
		}
		return out
	}, [savedConfigAll, schemaGroup])

	const defaults = useMemo(() => {
		if (!schemaGroup) return defaultsAll
		const out: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(defaultsAll)) {
			if (splitSchemaKey(key).group !== schemaGroup) continue
			out[key] = value
		}
		return out
	}, [defaultsAll, schemaGroup])

	const hasSchema = Object.keys(schemaMap).length > 0
	const layout = config.data?.layout ?? null
	return (
		<Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
			{config.error ? (
				<ErrorState
					title="加载配置失败"
					message={config.error.message || '无法获取配置信息'}
					onRetry={() => void config.refetch()}
					minHeight={200}
				/>
			) : config.loading && !config.data ? (
				<Center style={{ flex: 1, gap: 8 }}>
					<Loader size="sm" />
					<Text c="dimmed">加载配置中…</Text>
				</Center>
			) : hasSchema ? (
				layout && layout.length && !schemaGroup ? (
					<ConfigLayout
						pluginName={pluginName}
						layout={layout as any}
						schemas={schemaMap as any}
						savedConfig={savedConfig}
						defaults={defaults}
						active={active}
						onDirtyChange={onDirtyChange}
					/>
				) : (
					<ConfigForm
						key={`${pluginName ?? 'config-form'}:${schemaGroup ?? '__all__'}`}
						pluginName={pluginName}
						schemas={schemaMap}
						savedConfig={savedConfig}
						defaults={defaults}
						active={active}
						activeKey={activeSchemaKey}
						onActiveKeyChange={onSchemaChange}
						onDirtyChange={onDirtyChange}
					/>
				)
			) : (
				<EmptyState
					icon={<IconSettingsOff size={28} stroke={1.5} />}
					title="暂无可配置项"
					description="该插件未提供可配置的选项。"
					minHeight={200}
				/>
			)}
		</Box>
	)
}

function RouteContent({ pluginName, restPath }: { pluginName: string; restPath: string }) {
	const fullPath = useMemo(() => {
		return `/plugins/${encodeURIComponentSafe(pluginName)}${restPath}`
	}, [pluginName, restPath])
	const { pluginCtx, routeRender, routeVersion } = useResolvedPluginRoute({
		pluginName,
		pathname: fullPath,
		restPath,
	})

	return (
		<PluginRouteRenderer
			pluginName={pluginName}
			displayPath={fullPath}
			pathname={fullPath}
			pluginCtx={pluginCtx}
			routeRender={routeRender}
			routeVersion={routeVersion}
			backContent={
				<Button
					size="xs"
					variant="light"
					component={RouterLinkAdapter}
					to={`/plugins/${encodeURIComponentSafe(pluginName)}`}
				>
					返回插件详情
				</Button>
			}
			wrapContent={(content) => (
				<ScrollArea
					type="auto"
					scrollbarSize={10}
					offsetScrollbars
					style={{ flex: 1, minHeight: 0 }}
				>
					<Box p="xs" style={{ minHeight: '100%' }}>
						<Stack gap="sm" style={{ minHeight: '100%' }}>
							{content}
						</Stack>
					</Box>
				</ScrollArea>
			)}
		/>
	)
}

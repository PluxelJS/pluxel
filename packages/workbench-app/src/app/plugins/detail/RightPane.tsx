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
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectSchema } from 'valibot'
import { EmptyState, ErrorState } from '../../../components'
import { useResolvedWorkbenchRoute, useWorkbenchSurface } from '../../../workbench/runtime'
import type { PluginConfigState } from '../config/usePluginConfig'
import { RouterLinkAdapter } from '../../RouterLinkAdapter'
import type { PluginDetailSearch } from '../../router/pluginDetailSearch'
import { useCurrentPathname } from '../../router/useCurrentRoute'
import { WorkbenchRouteRenderer } from '../../router/workbench/WorkbenchRouteRenderer'
import { PANE_TABS_PROPS, PaneTabLabel, getPaneTabsRootClassName } from '../../workbench/PaneTabs'
import { useResolvedWorkbenchTabState } from '../../workbench/split'
import { ConfigForm } from '../config/ConfigForm'
import { ConfigLayout } from '../config/ConfigLayout'
import { compareSchemaKeys, PLUGIN_SCHEMA_GROUP, splitSchemaKey } from '../config/schemaKey'
import { DependencyList } from './cards/DependencyList'
import { LogLevelsCard } from './cards/LogLevelsCard'
import { PluginPanel } from './cards/PluginPanel'
import { ActionBar } from './controls/ActionBar'
import { usePluginMeta, usePluginScope } from './context'
import {
	getPluginScopedSearchCandidates,
	replacePluginDetailSearchParams,
	usePluginDetailSearch,
} from './pluginDetailSearchState'
import {
	buildRightPaneTabGroups,
	CONFIG_GROUP_TAB_PREFIX,
	deepEqual,
	encodeURIComponentSafe,
	formatCompactSource,
	isConfigTab,
	mergeRightPaneState,
	normalizeRestPath,
	resolveKnownPluginName,
	resolveActiveRightPaneTab,
	resolveStoredSchemaForTab,
	RIGHT_PANE_VIEW_STATE_KEY,
	sanitizeRightPaneState,
	type RightPaneState,
} from './rightPaneState'
import { usePluginWorkbenchLayout } from './workbench/context'
import { PluginWorkbenchTabActivityProvider } from './workbench/tabActivity'
import {
	useWorkbenchTabDirty,
	useWorkbenchTabIdentity,
	useWorkspaceController,
} from '../../workbench/context'

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

const EMPTY_CONFIG_RECORD: Record<string, unknown> = {}
type RightPaneRouteIntent = {
	signature: string
	state: RightPaneState
}

function PaneScrollBody({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
	return (
		<ScrollArea type="auto" scrollbarSize={10} offsetScrollbars style={COLUMN_STYLE}>
			<Box p="xs" style={{ minHeight: fill ? '100%' : undefined }}>
				{children}
			</Box>
		</ScrollArea>
	)
}

function filterSchemaGroupRecord<T>(values: Record<string, T>, schemaGroup?: string) {
	if (!schemaGroup) return values
	const out: Record<string, T> = {}
	for (const [key, value] of Object.entries(values)) {
		if (splitSchemaKey(key).group !== schemaGroup) continue
		out[key] = value
	}
	return out
}

function PaneTabPanel({ children, value }: { children: ReactNode; value: string }) {
	return (
		<Tabs.Panel value={value} className="plx-paneTabs__panel" style={COLUMN_STYLE}>
			{children}
		</Tabs.Panel>
	)
}

function PluginWorkbenchToolbar({
	configGroupTabs,
	resolveDependencyLinkTarget,
	isEnabled,
	isRunning,
	isSyncing,
	pluginName,
	rightPaneVisible,
	showConfigTab,
	showLevelsTab,
	showRouteTab,
	source,
	sourceCopyValue,
	sourcePreview,
	sourceTypeLabel,
	tabGroups,
}: {
	configGroupTabs: Array<{ id: string; label: string }>
	resolveDependencyLinkTarget: (name: string) => string | undefined
	isEnabled: boolean
	isRunning: boolean
	isSyncing: boolean
	pluginName: string
	rightPaneVisible: boolean
	showConfigTab: boolean
	showLevelsTab: boolean
	showRouteTab: boolean
	source: {
		kind: 'hmr' | 'package' | string
		moduleId?: string | null
		packageName?: string | null
	}
	sourceCopyValue: string | null
	sourcePreview: string
	sourceTypeLabel: string
	tabGroups: Array<{ id: string; label: string }>
}) {
	const sourceBadgeVariant = source.kind === 'hmr' ? 'filled' : 'light'
	const sourceBadgeColor =
		source.kind === 'hmr' ? 'brand' : source.kind === 'package' ? 'green' : 'gray'

	return (
		<div className="plx-pluginWorkbench__toolbar">
			<div className="plx-pluginWorkbench__commandBar">
				<div className="plx-pluginWorkbench__commandMeta">
					<div className="plx-pluginWorkbench__commandTitle">
						<span className="plx-pluginWorkbench__commandName">{pluginName}</span>
						<Badge size="sm" variant={sourceBadgeVariant} color={sourceBadgeColor}>
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
												copied ? '已复制' : (source.moduleId ?? source.packageName ?? '未知来源')
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
								resolveLinkTarget={resolveDependencyLinkTarget}
								linkWorkbenchMode="open-tab"
							/>
						</div>
					) : null}
				</div>

				<div className="plx-pluginWorkbench__commandActions">
					<ActionBar prominent />
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
	if (tabKeys.length === 0) return ''

	const fromSearch = params.resolveSchema(params.schemaFromSearch)
	if (fromSearch && tabKeys.includes(fromSearch)) return fromSearch

	const storedTabSchema = resolveStoredSchemaForTab(params.storedState, params.activeTab, tabKeys)
	if (storedTabSchema) return storedTabSchema

	const fromState = params.resolveSchema(params.storedState.schema)
	if (fromState && tabKeys.includes(fromState)) return fromState

	return tabKeys[0] ?? ''
}

function createRouteIntentSignature(restPath: string, search: PluginDetailSearch) {
	return `${restPath}\n${search.tab ?? ''}\n${search.schema ?? ''}`
}

function mergeDisplayState(base: RightPaneState, patch: RightPaneState): RightPaneState {
	return {
		...base,
		...patch,
		schemas: patch.schemas ? { ...base.schemas, ...patch.schemas } : base.schemas,
	}
}

export function RightPane({ config, showLevelsTab = false }: RightPaneProps) {
	const { pluginName, isEnabled, isRunning, isSyncing } = usePluginMeta()
	const { source, knownPluginNames } = usePluginScope()
	const { rightPaneVisible } = usePluginWorkbenchLayout()
	const { activeTabId } = useWorkbenchTabIdentity()
	const { setActiveTabDirty } = useWorkbenchTabDirty()
	const workspace = useWorkspaceController()
	const { nodes: tabNodes, items: tabItems } = useWorkbenchSurface('plugin.tabs')
	const pathname = useCurrentPathname()
	const routeSearch = usePluginDetailSearch()
	const [localSearchOverride, setLocalSearchOverride] = useState<PluginDetailSearch | null>(null)
	const tabGroups = useMemo(
		() => buildRightPaneTabGroups(pluginName, tabItems, tabNodes as ReactNode[]),
		[pluginName, tabItems, tabNodes],
	)
	const [configDirtyMap, setConfigDirtyMap] = useState<Record<string, boolean>>({})
	// 配置表单需要与自定义 Tab 共存：即使没有 schema，也展示一个“暂无可配置项”的稳定入口。
	const showConfigTab = true
	const storedState = useResolvedWorkbenchTabState(
		RIGHT_PANE_VIEW_STATE_KEY,
		sanitizeRightPaneState,
	)
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
	const appliedRouteIntentSignatureRef = useRef<string | null>(null)

	useEffect(() => {
		setLocalSearchOverride(null)
	}, [restPath, routeSearch.schema, routeSearch.tab])

	const effectiveRouteSearch = localSearchOverride ?? routeSearch

	const schemaKeys = useMemo(
		() => Object.keys(config.data?.schemaMap ?? {}),
		[config.data?.schemaMap],
	)

	const schemaKeysByConfigTab = useMemo(() => {
		const map = new Map<string, string[]>()
		const all = schemaKeys.slice().sort(compareSchemaKeys)

		const hasLayout = Boolean(config.data?.layout?.length > 0)
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
			if (keys.length === 0) continue
			out.push({ id, label: id.slice(CONFIG_GROUP_TAB_PREFIX.length) })
		}
		return out.sort((a, b) => a.label.localeCompare(b.label))
	}, [schemaKeysByConfigTab])

	const resolveTab = useCallback(
		(value: string | undefined) => {
			if (!value) return undefined
			const candidates = getPluginScopedSearchCandidates(value, pluginName)
			for (const candidate of candidates) {
				if (candidate === 'logging') return showLevelsTab ? 'logging' : undefined
				if (candidate === 'config' && showConfigTab) return 'config'
				if (candidate === 'route') return showRouteTab ? 'route' : undefined
				if (candidate.startsWith(CONFIG_GROUP_TAB_PREFIX)) {
					const resolvedConfigTab = schemaKeysByConfigTab.has(candidate) ? candidate : undefined
					if (resolvedConfigTab) return resolvedConfigTab
				}
				if (tabGroups.some((tab) => tab.id === candidate)) return candidate
			}
			return undefined
		},
		[pluginName, schemaKeysByConfigTab, showConfigTab, showLevelsTab, showRouteTab, tabGroups],
	)
	const resolveSchema = useCallback(
		(value: string | undefined) => (value && schemaKeys.includes(value) ? value : undefined),
		[schemaKeys],
	)
	const resolveConfigTabForSchema = useCallback(
		(schemaKey: string | undefined) => {
			if (!schemaKey) return undefined
			for (const [tabId, tabKeys] of schemaKeysByConfigTab.entries()) {
				if (tabKeys.includes(schemaKey)) return tabId
			}
			return undefined
		},
		[schemaKeysByConfigTab],
	)

	const routeIntent = useMemo<RightPaneRouteIntent | null>(() => {
		const search = {
			tab: effectiveRouteSearch.tab,
			schema: effectiveRouteSearch.schema,
		} satisfies PluginDetailSearch
		const hasSearchIntent = Boolean(search.tab || search.schema)
		if (hasSearchIntent) {
			const tabFromSearch = resolveTab(search.tab)
			const schemaFromSearch = resolveSchema(search.schema)
			if (search.schema && !schemaFromSearch && (config.loading || schemaKeys.length === 0)) {
				return null
			}
			const schemaTab = resolveConfigTabForSchema(schemaFromSearch)
			const tab = tabFromSearch ?? schemaTab
			if (!tab) return null
			const schema = tab && isConfigTab(tab) ? schemaFromSearch : undefined
			return {
				signature: createRouteIntentSignature(restPath, search),
				state: {
					path: restPath,
					tab,
					schema,
					schemas: tab && schema ? { [tab]: schema } : undefined,
				},
			}
		}
		if (showRouteTab) {
			return {
				signature: createRouteIntentSignature(restPath, search),
				state: { path: restPath, tab: 'route', schema: undefined },
			}
		}
		if (builtinTabFromPath) {
			return {
				signature: createRouteIntentSignature(restPath, search),
				state: { path: restPath, tab: builtinTabFromPath },
			}
		}
		if ((storedState.path ?? '') !== restPath) {
			return {
				signature: createRouteIntentSignature(restPath, search),
				state: { path: restPath },
			}
		}
		return null
	}, [
		builtinTabFromPath,
		effectiveRouteSearch.schema,
		effectiveRouteSearch.tab,
		config.loading,
		resolveConfigTabForSchema,
		resolveSchema,
		resolveTab,
		restPath,
		schemaKeys.length,
		showRouteTab,
		storedState.path,
	])
	const routeIntentPending = Boolean(
		routeIntent && appliedRouteIntentSignatureRef.current !== routeIntent.signature,
	)
	const displayState =
		routeIntent && routeIntentPending
			? mergeDisplayState(storedState, routeIntent.state)
			: storedState

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

	const storedPathMatches = (displayState.path ?? '') === restPath

	const activeTab = useMemo(
		() =>
			resolveActiveRightPaneTab({
				builtinTabFromPath,
				resolveTab,
				showRouteTab,
				showConfigTab,
				showLevelsTab,
				storedPathMatches,
				storedTab: displayState.tab,
				tabGroups,
			}),
		[
			builtinTabFromPath,
			displayState.tab,
			resolveTab,
			showConfigTab,
			showLevelsTab,
			showRouteTab,
			storedPathMatches,
			tabGroups,
		],
	)

	const activeSchemaKey = useMemo(
		() =>
			resolveActiveSchemaKey({
				activeTab,
				resolveSchema,
				schemaKeys,
				schemaKeysByConfigTab,
				schemaFromSearch: undefined,
				storedState: displayState,
			}),
		[activeTab, displayState, resolveSchema, schemaKeys, schemaKeysByConfigTab],
	)

	const persistState = useCallback(
		(next: RightPaneState) => {
			const previous = storedStateRef.current
			const merged = mergeRightPaneState(
				previous,
				{ ...next, path: restPath },
				activeTab,
				activeSchemaKey,
			)
			if (deepEqual(previous, merged)) return
			storedStateRef.current = merged
			workspace.setActiveTabState(activeTabId, RIGHT_PANE_VIEW_STATE_KEY, merged)
		},
		[activeSchemaKey, activeTab, activeTabId, restPath, workspace],
	)

	useEffect(() => {
		if (!routeIntent) return
		if (appliedRouteIntentSignatureRef.current === routeIntent.signature) return
		appliedRouteIntentSignatureRef.current = routeIntent.signature
		persistState(routeIntent.state)
	}, [persistState, routeIntent])

	const replaceLocalSearch = useCallback(
		(search: PluginDetailSearch) => {
			appliedRouteIntentSignatureRef.current = createRouteIntentSignature(restPath, search)
			setLocalSearchOverride(search)
			replacePluginDetailSearchParams({ schema: search.schema, tab: search.tab })
		},
		[restPath],
	)

	const handleTabChange = useCallback(
		(value: string | null) => {
			const next = String(value ?? 'config')
			const nextSchema = (() => {
				if (!isConfigTab(next)) return undefined
				const tabKeys = schemaKeysByConfigTab.get(next) ?? []
				if (tabKeys.length === 0) return undefined
				const stored = resolveStoredSchemaForTab(storedState, next, tabKeys)
				if (stored) return stored
				return tabKeys[0] ?? undefined
			})()

			persistState(
				nextSchema
					? { tab: next, schema: nextSchema, schemas: { [next]: nextSchema } }
					: { tab: next },
			)
			replaceLocalSearch({ tab: next, schema: nextSchema })
		},
		[persistState, replaceLocalSearch, schemaKeysByConfigTab, storedState],
	)

	const handleSchemaChangeForTab = useCallback(
		(tabId: string, nextKey: string) => {
			// Avoid inactive panels fighting the global URL/schema.
			if (activeTab !== tabId) return
			persistState({ schema: nextKey, schemas: { [tabId]: nextKey } })
			replaceLocalSearch({ tab: tabId, schema: nextKey })
		},
		[activeTab, persistState, replaceLocalSearch],
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
			if (tabKeys.length === 0) return ''

			if (activeTab === tabId) return activeSchemaKey

			const stored = resolveStoredSchemaForTab(displayState, tabId, tabKeys)
			if (stored) return stored

			return tabKeys[0] ?? ''
		},
		[activeSchemaKey, activeTab, displayState, schemaKeysByConfigTab],
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
	const resolveDependencyLinkTarget = useMemo(() => {
		return (name: string) => {
			return resolveKnownPluginName(knownPluginNames, name)
		}
	}, [knownPluginNames])

	return (
		<PluginPanel className="plx-pluginWorkbench__contentPanel" padding={4} gap={4}>
			<Box style={COLUMN_STYLE}>
				<Tabs
					{...PANE_TABS_PROPS}
					value={activeTab}
					onChange={handleTabChange}
					keepMounted
					style={COLUMN_STYLE}
					className={getPaneTabsRootClassName('toolbar')}
				>
					<PluginWorkbenchToolbar
						configGroupTabs={configGroupTabs}
						resolveDependencyLinkTarget={resolveDependencyLinkTarget}
						isEnabled={isEnabled}
						isRunning={isRunning}
						isSyncing={isSyncing}
						pluginName={pluginName}
						rightPaneVisible={rightPaneVisible}
						showConfigTab={showConfigTab}
						showLevelsTab={showLevelsTab}
						showRouteTab={showRouteTab}
						source={source}
						sourceCopyValue={sourceCopyValue}
						sourcePreview={sourcePreview}
						sourceTypeLabel={sourceTypeLabel}
						tabGroups={tabGroups}
					/>

					{showRouteTab ? (
						<PaneTabPanel value="route">
							<RouteContent pluginName={pluginName} restPath={restPath} />
						</PaneTabPanel>
					) : null}

					{showConfigTab ? (
						<PaneTabPanel value="config">
							<ConfigContent
								config={config}
								pluginName={pluginName}
								schemaGroup="__plugin__"
								active={activeTab === 'config'}
								activeSchemaKey={schemaKeyForTab('config')}
								onSchemaChange={(key) => handleSchemaChangeForTab('config', key)}
								onDirtyChange={(dirty) => handleConfigDirtyChange('config', dirty)}
							/>
						</PaneTabPanel>
					) : null}

					{showLevelsTab ? (
						<PaneTabPanel value="logging">
							<PaneScrollBody fill>
								<LogLevelsCard pluginId={pluginName} compact />
							</PaneScrollBody>
						</PaneTabPanel>
					) : null}

					{configGroupTabs.map((tab) => (
						<PaneTabPanel key={tab.id} value={tab.id}>
							<ConfigContent
								config={config}
								pluginName={pluginName}
								schemaGroup={tab.label}
								active={activeTab === tab.id}
								activeSchemaKey={schemaKeyForTab(tab.id)}
								onSchemaChange={(key) => handleSchemaChangeForTab(tab.id, key)}
								onDirtyChange={(dirty) => handleConfigDirtyChange(tab.id, dirty)}
							/>
						</PaneTabPanel>
					))}

					{tabGroups.map((tab) => {
						const id = tab.id
						const isActive = activeTab === id
						return (
							<PaneTabPanel key={id} value={id}>
								<PluginWorkbenchTabActivityProvider active={isActive}>
									<PaneScrollBody fill>
										<Stack gap="sm">
											{tab.nodes.map(({ key, node }) => (
												<Fragment key={key}>{node}</Fragment>
											))}
										</Stack>
									</PaneScrollBody>
								</PluginWorkbenchTabActivityProvider>
							</PaneTabPanel>
						)
					})}
				</Tabs>
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
	const schemaMapAll = (config.data?.schemaMap ?? EMPTY_CONFIG_RECORD) as Record<
		string,
		ObjectSchema<any, any>
	>
	const savedConfigAll = config.data?.savedConfig ?? EMPTY_CONFIG_RECORD
	const defaultsAll = config.data?.defaults ?? EMPTY_CONFIG_RECORD

	const schemaMap = useMemo(
		() => filterSchemaGroupRecord(schemaMapAll, schemaGroup),
		[schemaGroup, schemaMapAll],
	)
	const savedConfig = useMemo(
		() => filterSchemaGroupRecord(savedConfigAll, schemaGroup),
		[savedConfigAll, schemaGroup],
	)
	const defaults = useMemo(
		() => filterSchemaGroupRecord(defaultsAll, schemaGroup),
		[defaultsAll, schemaGroup],
	)

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
				layout && layout.length > 0 && !schemaGroup ? (
					<ConfigLayout
						pluginName={pluginName}
						layout={layout as any}
						schemas={schemaMap as any}
						savedConfig={savedConfig}
						defaults={defaults}
						active={active}
						activeKey={activeSchemaKey}
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
	const { route, snapshot } = useResolvedWorkbenchRoute(pluginName, restPath)

	return (
		<WorkbenchRouteRenderer
			pluginName={pluginName}
			displayPath={fullPath}
			pathname={fullPath}
			route={route}
			snapshot={snapshot}
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
				<PaneScrollBody fill>
					<Stack gap="sm" style={{ minHeight: '100%' }}>
						{content}
					</Stack>
				</PaneScrollBody>
			)}
		/>
	)
}

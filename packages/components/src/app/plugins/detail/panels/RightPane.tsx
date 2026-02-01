import {
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
	ScrollArea,
	Stack,
	Tabs,
	Text,
} from '@mantine/core'
import { IconSettingsOff } from '@tabler/icons-react'
import { useNavigate } from '@tanstack/react-router'
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectSchema } from 'valibot'
import { EmptyState, ErrorState } from '../../../../components'
import {
	ExtensionErrorBoundary,
	ExtensionProvider,
	getPluginRouteComponent,
	type PluginExtensionContext,
	useExtensionContext,
	useExtensionRuntimeVersion,
	useExtensions,
} from '../../../../extension'
import type { PluginConfigState } from '../../../hooks'
import { RouterLinkAdapter } from '../../../RouterLinkAdapter'
import { useCurrentPathname, useCurrentSearch } from '../../../router/useCurrentRoute'
import { FloatingTocScope } from '../../components/FloatingToc'
import { ConfigForm, compareSchemaKeys, PLUGIN_SCHEMA_GROUP, splitSchemaKey } from '../../config'
import { LogLevelsCard, PluginPanel } from '../components'
import { usePluginMeta } from '../context'

interface RightPaneProps {
	config: PluginConfigState
}

const COLUMN_STYLE = {
	flex: 1,
	minHeight: 0,
	display: 'flex',
	flexDirection: 'column' as const,
}

type RightPaneState = {
	tab?: string
	schema?: string
	/** per-tab schema selection (e.g. config vs cfg:cache) */
	schemas?: Record<string, string>
}

const CONFIG_GROUP_TAB_PREFIX = 'cfg:'

function isConfigTab(tab: string): boolean {
	return tab === 'config' || tab.startsWith(CONFIG_GROUP_TAB_PREFIX)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function readStringProp(obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key]
	return typeof value === 'string' ? value : undefined
}

function readNumberProp(obj: Record<string, unknown>, key: string): number | undefined {
	const value = obj[key]
	return typeof value === 'number' ? value : undefined
}

function readStringMap(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(value)) {
		if (typeof v === 'string') out[k] = v
	}
	return out
}

function normalizeRestPath(raw?: string): string {
	if (!raw) return ''
	let decoded = raw
	try {
		decoded = decodeURIComponent(raw)
	} catch {
		decoded = raw
	}
	const segments = decoded
		.split('/')
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
	if (segments.length === 0) return ''
	return `/${segments.join('/')}`
}

function encodeURIComponentSafe(value: string): string {
	try {
		return encodeURIComponent(value)
	} catch {
		return value
	}
}

function normalizeSearchRecord(input: unknown): Record<string, unknown> {
	if (!input) return {}
	if (typeof input === 'string') {
		const params = new URLSearchParams(input)
		const out: Record<string, unknown> = {}
		for (const [key, value] of params.entries()) {
			out[key] = value
		}
		return out
	}
	if (typeof input === 'object') return { ...(input as Record<string, unknown>) }
	return {}
}

function readSearchValue(search: unknown, key: string): string | undefined {
	if (!search) return undefined
	if (typeof search === 'string') {
		const value = new URLSearchParams(search).get(key)
		return value ?? undefined
	}
	if (typeof search === 'object') {
		const raw = (search as Record<string, unknown>)[key]
		if (typeof raw === 'string') return raw
		if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0]
	}
	return undefined
}

function readPaneState(key: string): RightPaneState {
	if (typeof window === 'undefined') return {}
	try {
		const raw = window.localStorage.getItem(key)
		if (!raw) return {}
		const parsed = JSON.parse(raw)
		if (!isRecord(parsed)) return {}
		return {
			tab: readStringProp(parsed, 'tab'),
			schema: readStringProp(parsed, 'schema'),
			schemas: readStringMap(parsed.schemas),
		}
	} catch {
		return {}
	}
}

function writePaneState(key: string, state: RightPaneState) {
	if (typeof window === 'undefined') return
	try {
		const payload = {
			tab: typeof state.tab === 'string' ? state.tab : undefined,
			schema: typeof state.schema === 'string' ? state.schema : undefined,
			schemas: state.schemas,
		}
		window.localStorage.setItem(key, JSON.stringify(payload))
	} catch {
		// ignore
	}
}

export function RightPane({ config }: RightPaneProps) {
	const { pluginName, isSyncing } = usePluginMeta()
	const { nodes: tabNodes, items: tabItems } = useExtensions('plugin:tabs')
	const navigate = useNavigate()
	const pathname = useCurrentPathname()
	const search = useCurrentSearch()
	const tabGroups = useMemo(() => {
		const entries = tabItems.map((item, index) => {
			const meta = isRecord(item.meta) ? item.meta : {}
			const nodeKey = readStringProp(meta, 'id') ?? `${pluginName}:tab:${index}`
			return {
				item,
				meta,
				node: tabNodes[index] as ReactNode,
				nodeKey,
			}
		})
		const byId = new Map<
			string,
			{
				id: string
				label: string
				priority: number
				nodes: Array<{ key: string; node: ReactNode }>
			}
		>()

		for (const { meta, node, nodeKey } of entries) {
			const tabMeta = isRecord(meta.tab) ? meta.tab : undefined
			const rawGroupId =
				typeof tabMeta?.id === 'string' && tabMeta.id.trim().length > 0
					? tabMeta.id.trim()
					: readStringProp(meta, 'id') && (readStringProp(meta, 'id') ?? '').length > 0
						? (readStringProp(meta, 'id') as string)
						: `${pluginName}:tab:${byId.size}`
			const groupId =
				rawGroupId === 'config' || rawGroupId === 'route'
					? `${pluginName}:tab:${rawGroupId}`
					: rawGroupId

			const itemLabel = readStringProp(meta, 'label')
			const tabLabel = tabMeta ? readStringProp(tabMeta, 'label') : undefined
			const groupLabel =
				typeof tabLabel === 'string' && tabLabel.trim().length > 0
					? tabLabel.trim()
					: typeof itemLabel === 'string' && itemLabel.trim().length > 0
						? itemLabel.trim()
						: '扩展面板'

			const existing = byId.get(groupId)
			if (!existing) {
				byId.set(groupId, {
					id: groupId,
					label: groupLabel,
					priority: readNumberProp(meta, 'priority') ?? 0,
					nodes: node ? [{ key: nodeKey, node }] : [],
				})
				continue
			}

			existing.priority = Math.max(existing.priority, readNumberProp(meta, 'priority') ?? 0)
			if (node) existing.nodes.push({ key: nodeKey, node })
		}

		return Array.from(byId.values()).sort((a, b) => {
			const prio = b.priority - a.priority
			if (prio !== 0) return prio
			return a.id.localeCompare(b.id)
		})
	}, [pluginName, tabItems, tabNodes])
	const [activeTab, setActiveTab] = useState('config')
	// 配置表单需要与自定义 Tab 共存：即使没有 schema，也展示一个“暂无可配置项”的稳定入口。
	const showConfigTab = true
	const storageKey = useMemo(() => `pluxel:plugin:${pluginName}:rightpane`, [pluginName])
	const [storedState, setStoredState] = useState<RightPaneState>(() => readPaneState(storageKey))

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

	const routeVersion = useExtensionRuntimeVersion(pluginName)
	const routeRender = useMemo(() => {
		if (!restPath) return undefined
		return getPluginRouteComponent(pluginName, restPath)
	}, [pluginName, restPath, routeVersion])
	const showRouteTab = Boolean(restPath)
	const lastRestPathRef = useRef<string>('')

	const updateSearch = useCallback(
		(patch: Record<string, string | undefined>, target?: string) => {
			const base = normalizeSearchRecord(search)
			const next = { ...base }
			let changed = false

			for (const [key, value] of Object.entries(patch)) {
				if (value === undefined || value === '') {
					if (key in next) {
						delete next[key]
						changed = true
					}
					continue
				}
				if (next[key] !== value) {
					next[key] = value
					changed = true
				}
			}

			const shouldNavigate = Boolean(target && target !== pathname)
			if (!changed && !shouldNavigate) return

			const to = target ?? pathname
			if (!to) return
			navigate({
				to,
				replace: true,
				search: next,
			})
		},
		[navigate, pathname, search],
	)

	const tabFromSearch = useMemo(() => readSearchValue(search, 'tab'), [search])
	const schemaFromSearch = useMemo(() => readSearchValue(search, 'schema'), [search])

	const schemaKeys = useMemo(
		() => Object.keys(config.data?.schemaMap ?? {}),
		[config.data?.schemaMap],
	)

	const schemaKeysByConfigTab = useMemo(() => {
		const map = new Map<string, string[]>()
		const all = schemaKeys.slice().sort(compareSchemaKeys)

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
	}, [schemaKeys])

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
			if (value === 'logging') return 'logging'
			if (value === 'config' && showConfigTab) return 'config'
			if (value === 'route') return showRouteTab ? 'route' : undefined
			if (value.startsWith(CONFIG_GROUP_TAB_PREFIX)) {
				return schemaKeysByConfigTab.has(value) ? value : undefined
			}
			return tabGroups.some((tab) => tab.id === value) ? value : undefined
		},
		[schemaKeysByConfigTab, showConfigTab, showRouteTab, tabGroups],
	)
	const resolveSchema = useCallback(
		(value: string | undefined) => (value && schemaKeys.includes(value) ? value : undefined),
		[schemaKeys],
	)

	const hasTabs = true

	useEffect(() => {
		setStoredState(readPaneState(storageKey))
	}, [storageKey])

	useEffect(() => {
		const resolved = resolveTab(tabFromSearch)
		const fallback = showRouteTab ? undefined : resolveTab(storedState.tab)
		const next =
			resolved ??
			(showRouteTab
				? 'route'
				: (fallback ?? (showConfigTab ? 'config' : (tabGroups[0]?.id ?? 'logging'))))
		if (next && next !== activeTab) setActiveTab(next)
	}, [
		activeTab,
		resolveTab,
		showConfigTab,
		showRouteTab,
		storedState.tab,
		tabFromSearch,
		tabGroups,
	])

	const activeSchemaKey = useMemo(() => {
		if (!isConfigTab(activeTab)) return ''
		const tabKeys = schemaKeysByConfigTab.get(activeTab) ?? schemaKeys
		if (!tabKeys.length) return ''

		const fromSearch = resolveSchema(schemaFromSearch)
		if (fromSearch && tabKeys.includes(fromSearch)) return fromSearch

		const storedTabSchema =
			storedState.schemas && typeof storedState.schemas === 'object'
				? storedState.schemas[activeTab]
				: undefined
		if (storedTabSchema && tabKeys.includes(storedTabSchema)) return storedTabSchema

		const fromState = resolveSchema(storedState.schema)
		if (fromState && tabKeys.includes(fromState)) return fromState

		return tabKeys[0] ?? ''
	}, [
		activeTab,
		resolveSchema,
		schemaFromSearch,
		schemaKeys,
		schemaKeysByConfigTab,
		storedState.schema,
		storedState.schemas,
	])

	useEffect(() => {
		if (!schemaKeys.length) return
		const tabKeys = schemaKeysByConfigTab.get(activeTab) ?? schemaKeys
		if (!tabKeys.length) return
		if (!isConfigTab(activeTab)) return
		const fromSearch = resolveSchema(schemaFromSearch)
		if (fromSearch && tabKeys.includes(fromSearch)) return
		if (activeSchemaKey) updateSearch({ schema: activeSchemaKey })
	}, [
		activeSchemaKey,
		activeTab,
		resolveSchema,
		schemaFromSearch,
		schemaKeys,
		schemaKeysByConfigTab,
		updateSearch,
	])

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
		updateSearch({ tab: 'route', schema: undefined })
	}, [restPath, showRouteTab, updateSearch])

	// Keep `schema` out of the URL when user is on the route tab.
	useEffect(() => {
		if (resolveTab(tabFromSearch) !== 'route') return
		if (!schemaFromSearch) return
		updateSearch({ schema: undefined })
	}, [resolveTab, schemaFromSearch, tabFromSearch, updateSearch])

	useEffect(() => {
		if (showRouteTab) return
		const resolved = resolveTab(tabFromSearch)
		if (resolved) return
		if (activeTab === 'route') return
		updateSearch({ tab: activeTab, schema: activeSchemaKey || undefined })
	}, [activeSchemaKey, activeTab, resolveTab, showRouteTab, tabFromSearch, updateSearch])

	const persistState = useCallback(
		(next: RightPaneState) => {
			const schemas =
				next.schemas && typeof next.schemas === 'object'
					? { ...(storedState.schemas ?? {}), ...next.schemas }
					: storedState.schemas
			const merged = {
				tab: typeof next.tab === 'string' ? next.tab : activeTab,
				schema: typeof next.schema === 'string' ? next.schema : activeSchemaKey,
				schemas,
			}
			writePaneState(storageKey, merged)
			setStoredState(merged)
		},
		[activeSchemaKey, activeTab, storageKey, storedState.schemas],
	)

	const handleTabChange = useCallback(
		(value: string | null) => {
			const next = String(value ?? 'config')
			setActiveTab(next)
			const nextSchema = (() => {
				if (!isConfigTab(next)) return undefined
				const tabKeys = schemaKeysByConfigTab.get(next) ?? []
				if (!tabKeys.length) return undefined
				const stored = storedState.schemas?.[next]
				if (stored && tabKeys.includes(stored)) return stored
				return tabKeys[0] ?? undefined
			})()

			persistState(
				nextSchema
					? { tab: next, schema: nextSchema, schemas: { [next]: nextSchema } }
					: { tab: next },
			)
			const patch: Record<string, string | undefined> = {
				tab: next,
				schema: isConfigTab(next) ? nextSchema : undefined,
			}
			updateSearch(patch)
		},
		[persistState, schemaKeysByConfigTab, storedState.schemas, updateSearch],
	)

	const handleSchemaChangeForTab = useCallback(
		(tabId: string, nextKey: string) => {
			// Avoid inactive panels fighting the global URL/schema.
			if (activeTab !== tabId) return
			persistState({ schema: nextKey, schemas: { [tabId]: nextKey } })
			if (!isConfigTab(activeTab)) return
			updateSearch({ schema: nextKey })
		},
		[activeTab, persistState, updateSearch],
	)

	const schemaKeyForTab = useCallback(
		(tabId: string) => {
			const tabKeys = schemaKeysByConfigTab.get(tabId) ?? []
			if (!tabKeys.length) return ''

			if (activeTab === tabId) return activeSchemaKey

			const stored = storedState.schemas?.[tabId]
			if (stored && tabKeys.includes(stored)) return stored

			return tabKeys[0] ?? ''
		},
		[activeSchemaKey, activeTab, schemaKeysByConfigTab, storedState.schemas],
	)

	return (
		<PluginPanel padding="sm" gap="sm">
			<Box style={COLUMN_STYLE}>
				{hasTabs ? (
					<Tabs
						value={activeTab}
						onChange={handleTabChange}
						keepMounted
						size="sm"
						radius="sm"
						style={COLUMN_STYLE}
					>
						<Group gap="xs" align="center" justify="space-between" wrap="nowrap">
							<Tabs.List
								style={{
									flex: 1,
									minWidth: 0,
									overflowX: 'auto',
									overflowY: 'hidden',
									flexWrap: 'nowrap',
								}}
							>
								{showRouteTab ? <Tabs.Tab value="route">页面</Tabs.Tab> : null}
								{showConfigTab ? <Tabs.Tab value="config">配置</Tabs.Tab> : null}
								<Tabs.Tab value="logging">日志</Tabs.Tab>
								{configGroupTabs.map((tab) => (
									<Tabs.Tab key={tab.id} value={tab.id}>
										{tab.label}
									</Tabs.Tab>
								))}
								{tabGroups.map((tab) => (
									<Tabs.Tab key={tab.id} value={tab.id}>
										{tab.label}
									</Tabs.Tab>
								))}
							</Tabs.List>
							{isSyncing ? (
								<Badge variant="dot" color="blue" radius="sm">
									同步中…
								</Badge>
							) : null}
						</Group>

						{showRouteTab ? (
							<Tabs.Panel value="route" style={COLUMN_STYLE}>
								<FloatingTocScope active={activeTab === 'route'}>
									<RouteContent
										pluginName={pluginName}
										restPath={restPath}
										routeRender={routeRender}
									/>
								</FloatingTocScope>
							</Tabs.Panel>
						) : null}

						{showConfigTab ? (
							<Tabs.Panel value="config" style={COLUMN_STYLE}>
								<FloatingTocScope active={activeTab === 'config'}>
									<ConfigContent
										config={config}
										pluginName={pluginName}
										schemaGroup="__plugin__"
										active={activeTab === 'config'}
										activeSchemaKey={schemaKeyForTab('config')}
										onSchemaChange={(key) => handleSchemaChangeForTab('config', key)}
									/>
								</FloatingTocScope>
							</Tabs.Panel>
						) : null}

						<Tabs.Panel value="logging" style={COLUMN_STYLE}>
							<FloatingTocScope active={activeTab === 'logging'}>
								<ScrollArea type="auto" scrollbarSize={10} offsetScrollbars style={COLUMN_STYLE}>
									<Box p="xs" style={{ minHeight: '100%' }}>
										<LogLevelsCard pluginId={pluginName} />
									</Box>
								</ScrollArea>
							</FloatingTocScope>
						</Tabs.Panel>

						{configGroupTabs.map((tab) => (
							<Tabs.Panel key={tab.id} value={tab.id} style={COLUMN_STYLE}>
								<FloatingTocScope active={activeTab === tab.id}>
									<ConfigContent
										config={config}
										pluginName={pluginName}
										schemaGroup={tab.label}
										active={activeTab === tab.id}
										activeSchemaKey={schemaKeyForTab(tab.id)}
										onSchemaChange={(key) => handleSchemaChangeForTab(tab.id, key)}
									/>
								</FloatingTocScope>
							</Tabs.Panel>
						))}

						{tabGroups.map((tab) => {
							const id = tab.id
							return (
								<Tabs.Panel key={id} value={id} style={COLUMN_STYLE}>
									<FloatingTocScope active={activeTab === id}>
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
									</FloatingTocScope>
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
}: {
	config: PluginConfigState
	pluginName: string
	schemaGroup?: string
	active: boolean
	activeSchemaKey: string
	onSchemaChange: (key: string) => void
}) {
	const schemaMapAll = (config.data?.schemaMap ?? {}) as Record<
		string,
		ObjectSchema<unknown, unknown>
	>
	const savedConfigAll = (config.data?.savedConfig ?? {}) as Record<string, unknown>
	const defaultsAll = (config.data?.defaults ?? {}) as Record<string, unknown>

	const schemaMap = useMemo(() => {
		if (!schemaGroup) return schemaMapAll
		const out: Record<string, ObjectSchema<unknown, unknown>> = {}
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
				<ConfigForm
					key={`${pluginName ?? 'config-form'}:${schemaGroup ?? '__all__'}`}
					pluginName={pluginName}
					schemas={schemaMap}
					savedConfig={savedConfig}
					defaults={defaults}
					active={active}
					activeKey={activeSchemaKey}
					onActiveKeyChange={onSchemaChange}
				/>
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

function RouteContent({
	pluginName,
	restPath,
	routeRender,
}: {
	pluginName: string
	restPath: string
	routeRender: ((ctx: PluginExtensionContext) => ReactNode) | undefined
}) {
	const ctx = useExtensionContext()
	const runningPlugins = ctx.runningPlugins
	const runningPluginsReady = ctx.runningPluginsReady
	const pluginRunning = runningPlugins.has(pluginName)
	const routeVersion = useExtensionRuntimeVersion(pluginName)

	const fullPath = useMemo(() => {
		return `/plugins/${encodeURIComponentSafe(pluginName)}${restPath}`
	}, [pluginName, restPath])

	const pluginCtx = useMemo<PluginExtensionContext>(
		() => ({
			...ctx,
			pathname: fullPath,
			pluginName,
		}),
		[ctx, fullPath, pluginName],
	)

	if (!pluginRunning && runningPluginsReady) {
		return (
			<Center style={{ flex: 1 }}>
				<Stack gap="xs" align="center">
					<Text fw={600}>插件未运行</Text>
					<Text c="dimmed" size="sm">
						请先启动插件 {pluginName}，才能访问 {fullPath}
					</Text>
					<Button
						size="xs"
						variant="light"
						component={RouterLinkAdapter}
						to={`/plugins/${encodeURIComponentSafe(pluginName)}`}
					>
						返回插件详情
					</Button>
				</Stack>
			</Center>
		)
	}

	if (routeVersion === 0) {
		return (
			<Center style={{ flex: 1, gap: 8 }}>
				<Loader size="sm" />
				<Text c="dimmed">扩展页面加载中…</Text>
			</Center>
		)
	}

	if (!routeRender) {
		return (
			<Center style={{ flex: 1 }}>
				<Stack gap="xs" align="center">
					<Text fw={600}>找不到扩展页面</Text>
					<Text c="dimmed" size="sm">
						该插件尚未注册页面：{fullPath}
					</Text>
					<Button
						size="xs"
						variant="light"
						component={RouterLinkAdapter}
						to={`/plugins/${encodeURIComponentSafe(pluginName)}`}
					>
						返回插件详情
					</Button>
				</Stack>
			</Center>
		)
	}

	return (
		<ScrollArea type="auto" scrollbarSize={10} offsetScrollbars style={{ flex: 1, minHeight: 0 }}>
			<Box p="xs" style={{ minHeight: '100%' }}>
				<ExtensionProvider value={pluginCtx}>
					<ExtensionErrorBoundary
						pluginName={pluginName}
						extensionId={`${pluginName}:route:${restPath || '/'}`}
						point={`route:${fullPath}`}
					>
						{routeRender(pluginCtx)}
					</ExtensionErrorBoundary>
				</ExtensionProvider>
			</Box>
		</ScrollArea>
	)
}

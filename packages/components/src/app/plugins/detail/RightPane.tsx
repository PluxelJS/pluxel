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
import type { ComponentType } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { EmptyState, ErrorState } from '../../../components'
import {
	ExtensionErrorBoundary,
	getPluginRouteComponent,
	useExtensionContext,
	useExtensionRuntimeVersion,
	useExtensions,
} from '../../../extension'
import type { PluginConfigState } from '../../hooks'
import { RouterLinkAdapter } from '../../RouterLinkAdapter'
import { ConfigForm } from '../config'
import { PluginPanel } from './components'
import { usePluginMeta } from './context'
import { useCurrentPathname, useCurrentSearch } from '../../router/useCurrentRoute'

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
		if (!parsed || typeof parsed !== 'object') return {}
		return {
			tab: typeof (parsed as any).tab === 'string' ? (parsed as any).tab : undefined,
			schema: typeof (parsed as any).schema === 'string' ? (parsed as any).schema : undefined,
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
		}
		window.localStorage.setItem(key, JSON.stringify(payload))
	} catch {}
}

export function RightPane({ config }: RightPaneProps) {
	const { pluginName, isSyncing } = usePluginMeta()
	const { nodes: tabNodes, items: tabItems } = useExtensions('plugin:tabs')
	const navigate = useNavigate()
	const pathname = useCurrentPathname()
	const search = useCurrentSearch()
	const encodedPluginName = useMemo(() => encodeURIComponentSafe(pluginName), [pluginName])
	const basePath = `/plugins/${encodedPluginName}`
	const tabGroups = useMemo(() => {
		const entries = tabItems.map((item, index) => ({ item, node: tabNodes[index] }))
		const byId = new Map<string, { id: string; label: string; priority: number; nodes: any[] }>()

		for (const { item, node } of entries) {
			const tabMeta = (item.meta as any)?.tab as { id?: unknown; label?: unknown } | undefined
			const rawGroupId =
				typeof tabMeta?.id === 'string' && tabMeta.id.trim().length > 0
					? tabMeta.id.trim()
					: typeof item.meta.id === 'string' && item.meta.id.length > 0
						? item.meta.id
						: `${pluginName}:tab:${byId.size}`
			const groupId =
				rawGroupId === 'config' || rawGroupId === 'route'
					? `${pluginName}:tab:${rawGroupId}`
					: rawGroupId

			const groupLabel =
				typeof tabMeta?.label === 'string' && tabMeta.label.trim().length > 0
					? tabMeta.label.trim()
					: typeof (item.meta as any)?.label === 'string' &&
							String((item.meta as any).label).trim().length > 0
						? String((item.meta as any).label).trim()
						: '扩展面板'

			const existing = byId.get(groupId)
			if (!existing) {
				byId.set(groupId, {
					id: groupId,
					label: groupLabel,
					priority: typeof item.meta.priority === 'number' ? item.meta.priority : 0,
					nodes: node ? [node] : [],
				})
				continue
			}

			existing.priority = Math.max(
				existing.priority,
				typeof item.meta.priority === 'number' ? item.meta.priority : 0,
			)
			if (node) existing.nodes.push(node)
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
	const storageKey = useMemo(
		() => `pluxel:plugin:${pluginName}:rightpane`,
		[pluginName],
	)
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
	const RouteComponent = useMemo(() => {
		if (!restPath) return undefined
		return getPluginRouteComponent(pluginName, restPath)
	}, [pluginName, restPath, routeVersion])
	const showRouteTab = Boolean(restPath)

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

			const nav = { replace: true, search: next } as {
				replace: true
				search: Record<string, unknown>
				to?: string
			}
			if (target) nav.to = target
			void navigate(nav as never)
		},
		[navigate, pathname, search],
	)

	const tabFromSearch = useMemo(() => readSearchValue(search, 'tab'), [search])
	const schemaFromSearch = useMemo(() => readSearchValue(search, 'schema'), [search])

	const resolveTab = useCallback(
		(value: string | undefined) => {
			if (!value) return undefined
			if (value === 'config' && showConfigTab) return 'config'
			if (value === 'route') return showRouteTab ? 'route' : undefined
			return tabGroups.some((tab) => tab.id === value) ? value : undefined
		},
		[showConfigTab, showRouteTab, tabGroups],
	)

	const schemaKeys = useMemo(
		() => Object.keys(config.data?.schemaMap ?? {}),
		[config.data?.schemaMap],
	)
	const resolveSchema = useCallback(
		(value: string | undefined) => (value && schemaKeys.includes(value) ? value : undefined),
		[schemaKeys],
	)

	const hasTabs = showConfigTab || tabGroups.length > 0 || showRouteTab

	useEffect(() => {
		setStoredState(readPaneState(storageKey))
	}, [storageKey])

	useEffect(() => {
		if (showRouteTab) {
			if (activeTab !== 'route') setActiveTab('route')
			return
		}
		const resolved = resolveTab(tabFromSearch)
		const fallback = resolveTab(storedState.tab)
		const next =
			resolved ??
			fallback ??
			(showConfigTab ? 'config' : tabGroups[0]?.id ?? 'config')
		if (next && next !== activeTab) setActiveTab(next)
	}, [activeTab, resolveTab, showConfigTab, showRouteTab, storedState.tab, tabFromSearch, tabGroups])

	const activeSchemaKey = useMemo(() => {
		return resolveSchema(schemaFromSearch) ?? resolveSchema(storedState.schema) ?? schemaKeys[0] ?? ''
	}, [resolveSchema, schemaFromSearch, schemaKeys, storedState.schema])

	useEffect(() => {
		if (!schemaKeys.length) return
		if (resolveSchema(schemaFromSearch)) return
		if (activeTab !== 'config') return
		if (activeSchemaKey) updateSearch({ schema: activeSchemaKey })
	}, [activeSchemaKey, activeTab, resolveSchema, schemaFromSearch, schemaKeys, updateSearch])

	useEffect(() => {
		if (showRouteTab) return
		const resolved = resolveTab(tabFromSearch)
		if (resolved) return
		if (activeTab === 'route') return
		updateSearch({ tab: activeTab, schema: activeSchemaKey || undefined })
	}, [activeSchemaKey, activeTab, resolveTab, showRouteTab, tabFromSearch, updateSearch])

	const persistState = useCallback(
		(next: RightPaneState) => {
			const merged = {
				tab: typeof next.tab === 'string' ? next.tab : activeTab,
				schema: typeof next.schema === 'string' ? next.schema : activeSchemaKey,
			}
			writePaneState(storageKey, merged)
			setStoredState(merged)
		},
		[activeSchemaKey, activeTab, storageKey],
	)

	const handleTabChange = useCallback(
		(value: string | null) => {
			const next = String(value ?? 'config')
			setActiveTab(next)
			persistState({ tab: next })
			if (next === 'route') return
			const patch: Record<string, string | undefined> = {
				tab: next,
				schema: activeSchemaKey || undefined,
			}
			updateSearch(patch, restPath ? basePath : undefined)
		},
		[activeSchemaKey, basePath, persistState, restPath, updateSearch],
	)

	const handleSchemaChange = useCallback(
		(nextKey: string) => {
			persistState({ schema: nextKey })
			if (activeTab !== 'config') return
			updateSearch({ schema: nextKey })
		},
		[activeTab, persistState, updateSearch],
	)

	return (
		<PluginPanel
			padding="sm"
			gap="sm"
		>
			<Box style={COLUMN_STYLE}>
				{hasTabs ? (
					<Tabs
						value={activeTab}
						onChange={handleTabChange}
						keepMounted
						style={COLUMN_STYLE}
					>
						<Group gap="xs" align="center" justify="space-between" wrap="nowrap">
							<Tabs.List style={{ flex: 1, minWidth: 0 }}>
								{showRouteTab ? <Tabs.Tab value="route">页面</Tabs.Tab> : null}
								{showConfigTab ? <Tabs.Tab value="config">配置</Tabs.Tab> : null}
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
								<RouteContent
									pluginName={pluginName}
									restPath={restPath}
									RouteComponent={RouteComponent}
								/>
							</Tabs.Panel>
						) : null}

						{showConfigTab ? (
							<Tabs.Panel value="config" style={COLUMN_STYLE}>
								<ConfigContent
									config={config}
									pluginName={pluginName}
									active={activeTab === 'config'}
									activeSchemaKey={activeSchemaKey}
									onSchemaChange={handleSchemaChange}
								/>
							</Tabs.Panel>
						) : null}

						{tabGroups.map((tab) => {
							const id = tab.id
							return (
								<Tabs.Panel key={id} value={id} style={COLUMN_STYLE}>
									<ScrollArea
										type="auto"
										scrollbarSize={10}
										offsetScrollbars
										style={COLUMN_STYLE}
									>
										<Box p="xs" style={{ minHeight: '100%' }}>
											<Stack gap="sm">{tab.nodes}</Stack>
										</Box>
									</ScrollArea>
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
						onSchemaChange={handleSchemaChange}
					/>
				)}
			</Box>
		</PluginPanel>
	)
}

function ConfigContent({
	config,
	pluginName,
	active,
	activeSchemaKey,
	onSchemaChange,
}: {
	config: PluginConfigState
	pluginName: string
	active: boolean
	activeSchemaKey: string
	onSchemaChange: (key: string) => void
}) {
	const hasSchema = Object.keys(config.data?.schemaMap ?? {}).length > 0
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
					key={pluginName ?? 'config-form'}
					pluginName={pluginName}
					schemas={config.data.schemaMap}
					savedConfig={config.data.savedConfig}
					defaults={config.data.defaults}
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
	RouteComponent,
}: {
	pluginName: string
	restPath: string
	RouteComponent: ComponentType | undefined
}) {
	const ctx = useExtensionContext()
	const runningPlugins = ctx.runningPlugins
	const runningPluginsReady = ctx.runningPluginsReady
	const pluginRunning = runningPlugins.has(pluginName)
	const routeVersion = useExtensionRuntimeVersion(pluginName)

	const fullPath = useMemo(() => {
		return `/plugins/${encodeURIComponentSafe(pluginName)}${restPath}`
	}, [pluginName, restPath])

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

	if (!RouteComponent) {
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
				<ExtensionErrorBoundary
					pluginName={pluginName}
					extensionId={`${pluginName}:route:${restPath || '/'}`}
					point={`route:${fullPath}`}
				>
					<RouteComponent />
				</ExtensionErrorBoundary>
			</Box>
		</ScrollArea>
	)
}

import { Badge, Box, Button, Center, Loader, ScrollArea, Stack, Tabs, Text } from '@mantine/core'
import { IconSettingsOff } from '@tabler/icons-react'
import { useRouterState } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
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
import { PluginPanel, PluginSection } from './components'
import { usePluginMeta } from './context'

interface RightPaneProps {
	config: PluginConfigState
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

export function RightPane({ config }: RightPaneProps) {
	const { pluginName, isSyncing } = usePluginMeta()
	const { nodes: tabNodes, items: tabItems } = useExtensions('plugin:tabs')
	const pathname = useRouterState({ select: (state) => state.location.pathname })
	const column = useMemo(
		() => ({ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' as const }),
		[],
	)
	const tabDefs = useMemo(
		() =>
			tabItems.map((item, index) => {
				const rawId =
					typeof item.meta.id === 'string' && item.meta.id.length > 0
						? item.meta.id
						: `${pluginName}:tab:${index}`
				const id = rawId === 'config' ? `${pluginName}:tab:${index}` : rawId
				const label =
					typeof item.meta.label === 'string' && item.meta.label.length > 0
						? (item.meta.label as string)
						: `扩展面板 ${index + 1}`
				return { id, label }
			}),
		[pluginName, tabItems],
	)
	const [activeTab, setActiveTab] = useState('config')
	// 配置表单需要与自定义 Tab 共存：即使没有 schema，也展示一个“暂无可配置项”的稳定入口。
	const showConfigTab = true

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

	const routeVersion = useExtensionRuntimeVersion()
	const RouteComponent = useMemo(() => {
		if (!restPath) return undefined
		return getPluginRouteComponent(pluginName, restPath)
	}, [pluginName, restPath, routeVersion])
	const showRouteTab = Boolean(restPath)

	const hasTabs = tabNodes.length > 0 || showRouteTab

	useEffect(() => {
		if (showRouteTab) {
			setActiveTab('route')
			return
		}
		const fallback = tabDefs[0]?.id ?? 'config'
		setActiveTab(showConfigTab ? 'config' : fallback)
	}, [pluginName, showConfigTab, showRouteTab, tabDefs])

	useEffect(() => {
		if (showRouteTab) {
			if (activeTab !== 'route') setActiveTab('route')
			return
		}
		if (activeTab === 'config' && showConfigTab) return
		if (!tabDefs.some((tab) => tab.id === activeTab)) {
			const fallback = showConfigTab ? 'config' : (tabDefs[0]?.id ?? 'config')
			setActiveTab(fallback)
		}
	}, [activeTab, showConfigTab, showRouteTab, tabDefs])

	return (
		<PluginPanel
			title="配置"
			rightSection={
				isSyncing ? (
					<Badge variant="dot" color="blue" radius="sm">
						同步中…
					</Badge>
				) : null
			}
			padding="lg"
			gap="lg"
		>
			<PluginSection grow>
				<Box style={column}>
					{hasTabs ? (
						<Tabs
							value={activeTab}
							onChange={(value) => setActiveTab(value ?? 'config')}
							keepMounted
							style={column}
						>
							<Tabs.List mb="sm">
								{showRouteTab ? <Tabs.Tab value="route">页面</Tabs.Tab> : null}
								{showConfigTab ? <Tabs.Tab value="config">配置</Tabs.Tab> : null}
								{tabDefs.map((tab) => (
									<Tabs.Tab key={tab.id} value={tab.id}>
										{tab.label}
									</Tabs.Tab>
								))}
							</Tabs.List>
							{showRouteTab ? (
								<Tabs.Panel value="route" style={column}>
									<RouteContent
										pluginName={pluginName}
										restPath={restPath}
										RouteComponent={RouteComponent}
									/>
								</Tabs.Panel>
							) : null}
							{showConfigTab ? (
								<Tabs.Panel value="config" style={column}>
									<ConfigContent config={config} pluginName={pluginName} />
								</Tabs.Panel>
							) : null}
							{tabNodes.map((node, index) => {
								const tab = tabDefs[index]
								const id = tab?.id ?? `${pluginName}:tab:${index}`
								return (
									<Tabs.Panel key={id} value={id} style={column}>
										<ScrollArea type="auto" scrollbarSize={10} offsetScrollbars style={column}>
											<Box p="xs" style={{ minHeight: '100%' }}>
												{node}
											</Box>
										</ScrollArea>
									</Tabs.Panel>
								)
							})}
						</Tabs>
					) : (
						<ConfigContent config={config} pluginName={pluginName} />
					)}
				</Box>
			</PluginSection>
		</PluginPanel>
	)
}

function ConfigContent({ config, pluginName }: { config: PluginConfigState; pluginName: string }) {
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
	RouteComponent: React.ComponentType | undefined
}) {
	const ctx = useExtensionContext()
	const runningPlugins = ctx.runningPlugins
	const runningPluginsReady = ctx.runningPluginsReady
	const pluginRunning = runningPlugins.has(pluginName)
	const routeVersion = useExtensionRuntimeVersion()

	const fullPath = useMemo(() => {
		const encoded = (() => {
			try {
				return encodeURIComponent(pluginName)
			} catch {
				return pluginName
			}
		})()
		return `/plugins/${encoded}${restPath}`
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
						to={`/plugins/${encodeURIComponent(pluginName)}`}
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
						to={`/plugins/${encodeURIComponent(pluginName)}`}
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

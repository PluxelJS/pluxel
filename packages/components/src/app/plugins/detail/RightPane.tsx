import { Badge, Box, Center, Loader, ScrollArea, Tabs, Text } from '@mantine/core'
import { IconSettingsOff } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import { EmptyState, ErrorState } from '../../../components'
import { useExtensions } from '../../../extension'
import type { PluginConfigState } from '../../hooks'
import { ConfigForm } from '../config'
import { PluginPanel, PluginSection } from './components'
import { usePluginMeta } from './context'

interface RightPaneProps {
	config: PluginConfigState
}

export function RightPane({ config }: RightPaneProps) {
	const { pluginName, isSyncing } = usePluginMeta()
	const { nodes: tabNodes, items: tabItems } = useExtensions('plugin:tabs')
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
	const hasTabs = tabNodes.length > 0

	useEffect(() => {
		const fallback = tabDefs[0]?.id ?? 'config'
		setActiveTab(showConfigTab ? 'config' : fallback)
	}, [pluginName, showConfigTab, tabDefs])

	useEffect(() => {
		if (activeTab === 'config' && showConfigTab) return
		if (!tabDefs.some((tab) => tab.id === activeTab)) {
			const fallback = showConfigTab ? 'config' : (tabDefs[0]?.id ?? 'config')
			setActiveTab(fallback)
		}
	}, [activeTab, showConfigTab, tabDefs])

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
							keepMounted={false}
							style={column}
						>
							<Tabs.List mb="sm">
								{showConfigTab ? <Tabs.Tab value="config">配置</Tabs.Tab> : null}
								{tabDefs.map((tab) => (
									<Tabs.Tab key={tab.id} value={tab.id}>
										{tab.label}
									</Tabs.Tab>
								))}
							</Tabs.List>
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

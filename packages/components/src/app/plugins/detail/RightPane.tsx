import { Badge, Box, Center, Loader, Tabs, Text } from '@mantine/core'
import { IconSettingsOff } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import { EmptyState, ErrorState } from '../../../components'
import { useExtensions } from '../../../extension'
import { ConfigForm } from '../config'
import { usePluginMeta } from './context'
import type { PluginConfigState } from '../../hooks'
import { PluginPanel } from './PluginPanel'
import { PluginSection } from './PluginSection'

interface RightPaneProps {
	config: PluginConfigState
}

export function RightPane({ config }: RightPaneProps) {
	const { pluginName, isSyncing } = usePluginMeta()
	const { nodes: tabNodes, items: tabItems } = useExtensions('plugin:tabs')
	const tabDefs = useMemo(
		() =>
			tabItems.map((item, index) => {
				const id =
					(typeof item.meta.id === 'string' && item.meta.id.length > 0
						? item.meta.id
						: `${pluginName}:tab:${index}`) ?? `${pluginName}:tab:${index}`
				const label =
					typeof item.meta.label === 'string' && item.meta.label.length > 0
						? (item.meta.label as string)
						: `扩展面板 ${index + 1}`
				return { id, label }
			}),
		[pluginName, tabItems],
	)
	const [activeTab, setActiveTab] = useState('config')
	const hasConfigSchema = useMemo(
		() => Object.keys(config.data?.schemaMap ?? {}).length > 0,
		[config.data?.schemaMap],
	)
	const showConfigTab = hasConfigSchema || config.loading || Boolean(config.error)
	const hasTabs = tabNodes.length > 0

	useEffect(() => {
		const fallback = tabDefs[0]?.id ?? 'config'
		setActiveTab(showConfigTab ? 'config' : fallback)
	}, [pluginName, showConfigTab, tabDefs])

	useEffect(() => {
		if (activeTab === 'config' && showConfigTab) return
		if (!tabDefs.some((tab) => tab.id === activeTab)) {
			const fallback = showConfigTab ? 'config' : tabDefs[0]?.id ?? 'config'
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
				<Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
					{hasTabs ? (
						<Tabs
							value={activeTab}
							onChange={(value) => setActiveTab(value ?? 'config')}
							keepMounted={false}
							style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
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
								<Tabs.Panel
									value="config"
									style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
								>
									<ConfigContent config={config} pluginName={pluginName} />
								</Tabs.Panel>
							) : null}
							{tabNodes.map((node, index) => {
								const tab = tabDefs[index]
								const id = tab?.id ?? `${pluginName}:tab:${index}`
								return (
									<Tabs.Panel
										key={id}
										value={id}
										style={{
											flex: 1,
											minHeight: 0,
											display: 'flex',
											flexDirection: 'column',
										}}
									>
										{node}
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
	return (
		<Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
			{config.error && !config.data ? (
				<ErrorState
					title="加载配置失败"
					message={config.error.message || '无法获取配置信息'}
					onRetry={() => void config.refetch()}
					minHeight={200}
				/>
			) : config.data?.schemaMap ? (
				<ConfigForm
					key={pluginName ?? 'config-form'}
					pluginName={pluginName}
					schemas={config.data.schemaMap}
					savedConfig={config.data.savedConfig}
					defaults={config.data.defaults}
				/>
			) : config.loading ? (
				<Center style={{ flex: 1, gap: 8 }}>
					<Loader size="sm" />
					<Text c="dimmed">加载配置中…</Text>
				</Center>
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

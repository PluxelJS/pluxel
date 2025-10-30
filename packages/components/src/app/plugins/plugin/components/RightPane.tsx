import { Badge, Box, Button, Center, Text } from '@mantine/core'
import { ConfigForm } from '../../ConfigForm'
import { usePluginMeta } from '../context'
import type { PluginConfigState } from '../hooks/usePluginConfig'
import { PluginPanel } from './PluginPanel'
import { PluginSection } from './PluginSection'

interface RightPaneProps {
	config: PluginConfigState
}

export function RightPane({ config }: RightPaneProps) {
	const { pluginName, isSyncing } = usePluginMeta()

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
					{config.error && !config.data ? (
						<Center style={{ flex: 1, gap: 12, flexDirection: 'column' }}>
							<Text c="red">{config.error.message || '加载配置失败'}</Text>
							<Button size="xs" onClick={() => void config.refetch()}>
								重试
							</Button>
						</Center>
					) : config.data?.config ? (
						<ConfigForm
							pluginName={pluginName}
							configs={config.data.config as any}
							existConfigs={config.data.existConfig as any}
						/>
					) : config.loading ? (
						<Center style={{ flex: 1 }}>
							<Text c="dimmed">加载配置中…</Text>
						</Center>
					) : (
						<Center style={{ flex: 1 }}>
							<Text c="dimmed">该插件暂无可配置项</Text>
						</Center>
					)}
				</Box>
			</PluginSection>
		</PluginPanel>
	)
}

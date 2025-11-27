import { Badge, Box, Center, Loader, Text } from '@mantine/core'
import { IconSettingsOff } from '@tabler/icons-react'
import { EmptyState, ErrorState } from '../../../../components'
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
						<ErrorState
							title="加载配置失败"
							message={config.error.message || '无法获取配置信息'}
							onRetry={() => void config.refetch()}
							minHeight={200}
						/>
					) : config.data?.schemaMap ? (
						<ConfigForm
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
			</PluginSection>
		</PluginPanel>
	)
}

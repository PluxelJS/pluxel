import { Badge, Box, Divider, Group, Paper, Stack, Text } from '@mantine/core'
import { memo } from 'react'
import { LiveLog as LiveLogRaw } from '../../../log_viewer/LiveLog'
import { RouterLinkAdapter } from '../../../RouterLinkAdapter'
import { usePluginMeta } from '../context'
import { ActionBar } from './ActionBar'
import { PluginPanel } from './PluginPanel'
import { PluginSourceCard } from './PluginSourceCard'

const LiveLog = memo(LiveLogRaw)

interface LeftPaneProps {
	compact?: boolean
}

export function LeftPane({ compact = false }: LeftPaneProps) {
	const { pluginName, description, isRunning, isSyncing } = usePluginMeta()

	const statusBadges = (
		<Group gap="xs" wrap="nowrap">
			<Badge variant="light" color={isRunning ? 'green' : 'gray'} radius="sm">
				{isRunning ? '运行中' : '已停止'}
			</Badge>
			{isSyncing ? (
				<Badge variant="dot" color="blue" radius="sm">
					同步中…
				</Badge>
			) : null}
		</Group>
	)

	return (
		<PluginPanel
			title={
				<Group gap="sm" align="center" wrap="nowrap">
					<Text fw={600} size="lg" lineClamp={1}>
						{pluginName}
					</Text>
					{statusBadges}
				</Group>
			}
			rightSection={<ActionBar />}
		>
			<Stack gap="md" style={{ flex: 1, minHeight: 0 }}>
				<Text size="sm" c="dimmed" lh={1.45}>
					{description || '暂无插件简介'}
				</Text>

				<PluginSourceCard LinkComponent={RouterLinkAdapter} />

				<Divider label="实时日志" labelPosition="left" />
				<Box style={{ flex: 1, minHeight: 0, display: 'flex' }}>
					<Paper
						withBorder
						p="sm"
						radius="md"
						shadow="xs"
						style={{
							flex: 1,
							minHeight: compact ? 220 : 320,
							display: 'flex',
							flexDirection: 'column',
							minWidth: 0,
						}}
					>
						<div style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
							<LiveLog module={pluginName} />
						</div>
					</Paper>
				</Box>
			</Stack>
		</PluginPanel>
	)
}

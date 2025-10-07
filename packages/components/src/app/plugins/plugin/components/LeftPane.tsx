import {
	Badge,
	Box,
	Card,
	CardSection,
	Divider,
	Group,
	Text,
	Title,
} from '@mantine/core'
import { Link } from 'wouter'
import { memo } from 'react'
import { usePluginMeta } from '../context'
import { ActionBar } from './ActionBar'
import { DependencyList } from './DependencyList'
import { LiveLog as LiveLogRaw } from '../../../log_viewer/LiveLog'

const CARD_FLEX_COL = {
	height: '100%',
	width: '100%',
	display: 'flex',
	flexDirection: 'column' as const,
	minHeight: 0,
	minWidth: 0,
	overflow: 'hidden',
}

const FLEX_1 = { flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }

const LiveLog = memo(LiveLogRaw)

export function LeftPane() {
	const { pluginName, description, isRunning, isSyncing } = usePluginMeta()

	return (
		<Card withBorder shadow="sm" style={CARD_FLEX_COL}>
			<CardSection withBorder px="md" py="sm">
				<Group justify="space-between" align="center" wrap="nowrap" style={{ minWidth: 0 }}>
					<Group gap="sm" align="center" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
						<Title order={3} fw={600} lh={1.2} style={{ minWidth: 0 }}>
							<Box
								style={{
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap',
								}}
								title={pluginName}
							>
								插件：{pluginName}
							</Box>
						</Title>
						<Badge variant="light" color={isRunning ? 'green' : 'gray'} radius="sm">
							{isRunning ? '运行中' : '已停止'}
						</Badge>
						<Badge
							variant="dot"
							color="blue"
							radius="sm"
							style={{ visibility: isSyncing ? 'visible' : 'hidden' }}
						>
							同步中…
						</Badge>
					</Group>
					<ActionBar />
				</Group>
			</CardSection>

			<CardSection px="md" py="sm" style={{ ...FLEX_1 }}>
				<Box
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: 'var(--mantine-spacing-sm)',
						flex: 1,
						minHeight: 0,
						minWidth: 0,
					}}
				>
					{description ? (
						<Text c="dimmed" size="sm" lh={1.4}>
							{description}
						</Text>
					) : (
						<Text size="sm" style={{ opacity: 0 }}>
							.
						</Text>
					)}

					<Divider label="依赖" />
					<Box style={{ flexShrink: 0 }}>
						<DependencyList LinkComponent={Link} />
					</Box>

					<Divider label="实时日志" />

					<Box
						style={{
							flex: 1,
							minHeight: 0,
							minWidth: 0,
							overflowX: 'auto',
							overflowY: 'auto',
						}}
					>
						<LiveLog module={pluginName} />
					</Box>
				</Box>
			</CardSection>
		</Card>
	)
}

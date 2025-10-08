import {
	Badge,
	Button,
	Card,
	CardSection,
	Center,
	Group,
	ScrollArea,
	Text,
	Title,
} from '@mantine/core'
import type { PluginConfigState } from '../hooks/usePluginConfig'
import { ConfigForm } from '../../ConfigForm'
import { usePluginMeta } from '../context'

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

interface RightPaneProps {
	config: PluginConfigState
}

export function RightPane({ config }: RightPaneProps) {
	const { pluginName, isSyncing } = usePluginMeta()

	return (
		<Card withBorder shadow="sm" style={CARD_FLEX_COL}>
			<CardSection withBorder px="md" py="sm">
				<Group justify="space-between" align="center" wrap="nowrap" style={{ minWidth: 0 }}>
					<Title order={4} fw={600}>
						配置
					</Title>
					<Badge
						variant="dot"
						color="blue"
						radius="sm"
						style={{ visibility: isSyncing ? 'visible' : 'hidden' }}
					>
						同步中…
					</Badge>
				</Group>
			</CardSection>

			<CardSection px="md" py="sm" style={{ ...FLEX_1 }}>
				<ScrollArea type="auto" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
					{config.error && !config.data ? (
						<Center mih={200} style={{ gap: 12, flexDirection: 'column' }}>
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
						<Center mih={200}>
							<Text c="dimmed">加载配置中…</Text>
						</Center>
					) : (
						<Center mih={200}>
							<Text c="dimmed">该插件暂无可配置项</Text>
						</Center>
					)}
				</ScrollArea>
			</CardSection>
		</Card>
	)
}

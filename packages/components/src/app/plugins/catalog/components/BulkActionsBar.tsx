import { ActionIcon, Badge, Group, Paper, Text } from '@mantine/core'
import { IconBan, IconPlayerStop, IconPower, IconX } from '@tabler/icons-react'

export type BulkAction = 'stop' | 'disable' | 'enable' | 'clear'

type Props = {
	count: number
	busy: boolean
	onAction: (action: BulkAction) => void
}

export function BulkActionsBar({ count, busy, onAction }: Props) {
	return (
		<Paper className="plx-pluginCatalog__bulkBar" withBorder radius="md" p={0} shadow="none">
			<Group justify="space-between" align="center" gap={6} wrap="nowrap">
				<div className="plx-pluginCatalog__bulkMeta">
					<Badge variant="light" color="gray" size="xs">
						已选 {count}
					</Badge>
					<Text className="plx-pluginCatalog__bulkTitle">批量操作</Text>
					<Text className="plx-pluginCatalog__bulkHint">空格切换选择，Esc 清空，Ctrl/⌘A 全选</Text>
				</div>
				<Group gap={4} wrap="nowrap">
					<ActionIcon
						size="sm"
						variant="subtle"
						disabled={busy}
						onClick={() => onAction('stop')}
						title="停止"
						aria-label="停止"
					>
						<IconPlayerStop size={14} />
					</ActionIcon>
					<ActionIcon
						size="sm"
						variant="subtle"
						disabled={busy}
						onClick={() => onAction('disable')}
						title="禁用"
						aria-label="禁用"
					>
						<IconBan size={14} />
					</ActionIcon>
					<ActionIcon
						size="sm"
						variant="subtle"
						disabled={busy}
						onClick={() => onAction('enable')}
						title="启用"
						aria-label="启用"
					>
						<IconPower size={14} />
					</ActionIcon>
					<ActionIcon
						size="sm"
						variant="subtle"
						disabled={busy}
						onClick={() => onAction('clear')}
						title="清空选择"
						aria-label="清空选择"
					>
						<IconX size={14} />
					</ActionIcon>
				</Group>
			</Group>
		</Paper>
	)
}

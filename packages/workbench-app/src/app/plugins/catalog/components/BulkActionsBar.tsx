import { ActionIcon, Badge, Group, Paper, Text } from '@mantine/core'
import { IconBan, IconPower, IconX } from '@tabler/icons-react'

export type BulkAction = 'auto-start-on' | 'auto-start-off' | 'clear'

type Props = {
	count: number
	busy: boolean
	onAction: (action: BulkAction) => void
}

export function BulkActionsBar({ count, busy, onAction }: Props) {
	return (
		<Paper className="plx-pluginCatalog__bulkBar" withBorder radius="sm" p={0} shadow="none">
			<Group justify="space-between" align="center" gap={6} wrap="nowrap">
				<div className="plx-pluginCatalog__bulkMeta">
					<Badge variant="light" color="gray" size="xs">
						已选 {count}
					</Badge>
					<Text className="plx-pluginCatalog__bulkTitle">批量操作</Text>
					<Text className="plx-pluginCatalog__bulkHint">
						Space 选择，Shift+方向 连选，Enter 打开，G/M/U 分组
					</Text>
				</div>
				<Group gap={4} wrap="nowrap">
					<ActionIcon
						size="sm"
						variant="subtle"
						disabled={busy}
						onClick={() => onAction('auto-start-off')}
						title="关闭自动启动（不停止当前会话）"
						aria-label="关闭自动启动"
					>
						<IconBan size={14} />
					</ActionIcon>
					<ActionIcon
						size="sm"
						variant="subtle"
						disabled={busy}
						onClick={() => onAction('auto-start-on')}
						title="开启自动启动（不启动当前会话）"
						aria-label="开启自动启动"
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

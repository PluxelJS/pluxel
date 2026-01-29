import { ActionIcon, Badge, Group, Paper } from '@mantine/core'
import { IconBan, IconPlayerStop, IconPower, IconX } from '@tabler/icons-react'

export type BulkAction = 'stop' | 'disable' | 'enable' | 'clear'

type Props = {
	count: number
	busy: boolean
	onAction: (action: BulkAction) => void
}

export function BulkActionsBar({ count, busy, onAction }: Props) {
	return (
		<Paper withBorder radius="xs" p={4} shadow="xs">
			<Group justify="space-between" align="center" gap={6} wrap="nowrap">
				<Badge variant="light" color="blue" size="xs">
					已选 {count}
				</Badge>
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

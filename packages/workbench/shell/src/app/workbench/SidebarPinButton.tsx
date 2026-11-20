import { ActionIcon, Tooltip } from '@mantine/core'
import { IconPin, IconPinnedOff } from '@tabler/icons-react'

export function SidebarPinButton({
	label,
	pinned,
	onToggle,
}: {
	label: string
	pinned?: boolean
	onToggle(): void
}) {
	const action = pinned ? '取消侧栏固定' : '固定到侧栏'
	return (
		<Tooltip label={action} events={{ hover: true, focus: true, touch: false }}>
			<ActionIcon
				variant={pinned ? 'light' : 'subtle'}
				size="sm"
				aria-label={`${action} ${label}`}
				aria-pressed={pinned}
				onClick={onToggle}
			>
				{pinned ? <IconPinnedOff size={14} aria-hidden /> : <IconPin size={14} aria-hidden />}
			</ActionIcon>
		</Tooltip>
	)
}

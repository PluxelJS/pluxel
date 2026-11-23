import { ActionIcon, Tooltip } from '@mantine/core'
import { IconRefresh } from '@tabler/icons-react'

export function RefreshAction({
	label,
	loading,
	onClick,
}: {
	label: string
	loading: boolean
	onClick: () => void
}) {
	return (
		<Tooltip label={label}>
			<ActionIcon
				type="button"
				variant="default"
				aria-label={label}
				loading={loading}
				onClick={onClick}
			>
				<IconRefresh size={16} aria-hidden />
			</ActionIcon>
		</Tooltip>
	)
}

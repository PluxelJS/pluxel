import { ActionIcon, Tooltip, Group } from '@mantine/core'
import { IconEdit, IconSettings, IconTrash } from '@tabler/icons-react'

export function ActionBar() {
	return (
		<Group gap="xs" align="right">
			<Tooltip label="Edit">
				<ActionIcon variant="light" size="lg">
					<IconEdit size={18} />
				</ActionIcon>
			</Tooltip>
			<Tooltip label="Settings">
				<ActionIcon variant="light" size="lg">
					<IconSettings size={18} />
				</ActionIcon>
			</Tooltip>
			<Tooltip label="Delete">
				<ActionIcon variant="light" size="lg" color="red">
					<IconTrash size={18} />
				</ActionIcon>
			</Tooltip>
		</Group>
	)
}

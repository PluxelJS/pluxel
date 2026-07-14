import { Badge, Tooltip } from '@mantine/core'
import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import { IconActivity } from '@tabler/icons-react'
import { PluginStatusBadgeUi } from '../../PluginStatusBadge.workbench'

const ui = createWorkbenchUi(PluginStatusBadgeUi)

export function StatusBadge() {
	const { activity } = ui.useResources()
	const connected = activity.useConnectionState().state === 'connected'

	return (
		<Tooltip label={connected ? 'SSE 已连接' : 'SSE 连接中'}>
			<Badge
				variant="dot"
				color={connected ? 'teal' : 'gray'}
				size="sm"
				leftSection={<IconActivity size={12} />}
			>
				{connected ? 'Live' : 'Offline'}
			</Badge>
		</Tooltip>
	)
}

export default ui.define({ StatusBadge })

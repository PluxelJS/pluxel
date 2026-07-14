import { Badge, Tooltip } from '@mantine/core'
import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import { IconActivity } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { PluginStatusBadgeWorkbench } from '../../PluginStatusBadge.workbench'

const plugin = createWorkbenchUi<typeof PluginStatusBadgeWorkbench>()

export function StatusBadge() {
	const { activity } = plugin.view('StatusBadge').useModel()
	const [connected, setConnected] = useState(false)

	useEffect(() => {
		return activity.onConnection(setConnected)
	}, [activity])

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

export default plugin.expose({ StatusBadge })

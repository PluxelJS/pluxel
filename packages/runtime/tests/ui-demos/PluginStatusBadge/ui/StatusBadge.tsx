import { Badge, Tooltip } from '@mantine/core'
import { managementApp } from '@pluxel/runtime/management/ui'
import { IconActivity } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { PluginStatusBadgeManagement } from '../../PluginStatusBadge.management'

const plugin = managementApp(PluginStatusBadgeManagement)

export function StatusBadge() {
	const app = plugin.use()
	const activity = app.stream('activity')
	const [connected, setConnected] = useState(false)

	useEffect(() => {
		const offOpen = activity.onOpen(() => setConnected(true))
		const offError = activity.onError(() => setConnected(false))
		return () => {
			offOpen()
			offError()
		}
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

export default plugin.define({ StatusBadge })

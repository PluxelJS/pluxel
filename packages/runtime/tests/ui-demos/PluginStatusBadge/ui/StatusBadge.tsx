// packages/runtime/tests/ui-demos/PluginStatusBadge/ui/StatusBadge.tsx
// 简单的状态徽章组件

import { Badge, Tooltip } from '@mantine/core'
import {
	definePluginUIModule,
	ExtensionPoints,
	pluginUi,
} from '@pluxel/runtime/web/ui'
import { IconActivity } from '@tabler/icons-react'
import { useEffect, useState } from 'react'

const plugin = pluginUi('PluginStatusBadge')

function StatusBadge() {
	const transport = plugin.useGlobal().transport
	const [connected, setConnected] = useState(false)

	useEffect(() => {
		const sse = transport.sse
		const offOpen = sse.onOpen(() => setConnected(true))
		const offErr = sse.onError(() => setConnected(false))
		return () => {
			offOpen()
			offErr()
		}
	}, [transport])

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

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.HeaderActions,
			id: 'status-badge',
			priority: 50,
			render: () => <StatusBadge />,
		},
	],
})

// packages/hmr/tests/plugins/ui-demos/PluginStatusBadge/ui/StatusBadge.tsx
// 简单的状态徽章组件

import { Badge, Tooltip } from '@mantine/core'
import { IconActivity } from '@tabler/icons-react'
import { definePluginUIModule, type GlobalExtensionContext } from '@pluxel/hmr/web'
import { useEffect, useState } from 'react'

function StatusBadge({ ctx }: { ctx: GlobalExtensionContext }) {
	const [connected, setConnected] = useState(false)

	useEffect(() => {
		const sse = ctx.services.hmr.sse
		const offOpen = sse.onOpen(() => setConnected(true))
		const offErr = sse.onError(() => setConnected(false))
		return () => {
			offOpen()
			offErr()
		}
	}, [ctx.services.hmr])

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

const module = definePluginUIModule({
	extensions: [
		{
			point: 'header:actions',
			id: 'status-badge',
			priority: 50,
			Component: StatusBadge,
		},
	],
	setup({ pluginName }) {
		console.log(`[${pluginName}] UI loaded`)
	},
})

export const { extensions, setup } = module
export default module

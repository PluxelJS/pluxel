import { Button } from '@mantine/core'
import { IconApi } from '@tabler/icons-react'
import { useWorkbenchHost } from '@pluxel/runtime/workbench/ui'
import { GatewayDashboard, GatewayPanel } from './panels'
import { gatewayUi } from './runtime'

function pluginRouteHref(pluginName: string, path: string) {
	return `/plugins/${encodeURIComponent(pluginName)}${path}`
}

export function HeaderAction() {
	const app = useWorkbenchHost()
	return (
		<Button
			component="a"
			href={pluginRouteHref(app.targetPluginId, '/dashboard')}
			variant="light"
			size="xs"
			leftSection={<IconApi size={14} />}
		>
			Gateway RPC
		</Button>
	)
}

export default gatewayUi.expose({ HeaderAction, GatewayPanel, GatewayDashboard })

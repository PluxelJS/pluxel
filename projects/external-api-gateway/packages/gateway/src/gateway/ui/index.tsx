import { Button } from '@mantine/core'
import { IconApi } from '@tabler/icons-react'
import { GatewayDashboard, GatewayPanel } from './panels'
import { gatewayPlugin } from './runtime'

function pluginRouteHref(pluginName: string, path: string) {
	return `/plugins/${encodeURIComponent(pluginName)}${path}`
}

export function HeaderAction() {
	const app = gatewayPlugin.use()
	return (
		<Button
			component="a"
			href={pluginRouteHref(app.target, '/dashboard')}
			variant="light"
			size="xs"
			leftSection={<IconApi size={14} />}
		>
			Gateway RPC
		</Button>
	)
}

export default gatewayPlugin.define({ HeaderAction, GatewayPanel, GatewayDashboard })

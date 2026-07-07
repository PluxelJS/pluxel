import { Button } from '@mantine/core'
import { definePluginUIModule, ExtensionPoints } from '@pluxel/runtime/web/ui'
import { IconApi, IconShieldLock } from '@tabler/icons-react'
import { GatewayDashboard, GatewayPanel } from './panels'
import { gatewayPlugin } from './runtime'

function pluginRouteHref(pluginName: string, path: string) {
	return `/plugins/${encodeURIComponent(pluginName)}${path}`
}

function HeaderAction() {
	const app = gatewayPlugin.useGlobal()
	return (
		<Button
			component="a"
			href={pluginRouteHref(app.pluginName, '/dashboard')}
			variant="light"
			size="xs"
			leftSection={<IconApi size={14} />}
		>
			Gateway RPC
		</Button>
	)
}

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.HeaderActions,
			id: 'external-gateway-header-action',
			priority: 110,
			requireRunning: true,
			render: () => <HeaderAction />,
		},
		{
			point: ExtensionPoints.PluginTabs,
			id: 'external-gateway-tokens',
			priority: 30,
			meta: { label: '外部访问', icon: <IconShieldLock size={16} /> },
			render: () => <GatewayPanel />,
		},
	],
	routes: [
		{
			definition: {
				path: '/dashboard',
				title: 'External Gateway RPC',
				icon: <IconApi size={18} stroke={1.7} />,
				addToNav: true,
				navPriority: 100,
			},
			render: () => <GatewayDashboard />,
		},
	],
})

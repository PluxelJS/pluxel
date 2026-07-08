import { Button } from '@mantine/core'
import { definePluginUIModule, ExtensionPoints } from '@pluxel/runtime/web/ui'
import { IconChartBar, IconReceipt } from '@tabler/icons-react'
import { BillingDashboard, BillingPanel } from './panels'
import { billingPlugin } from './runtime'

function pluginRouteHref(pluginName: string, path: string) {
	return `/plugins/${encodeURIComponent(pluginName)}${path}`
}

function HeaderAction() {
	const app = billingPlugin.useGlobal()
	return (
		<Button
			component="a"
			href={pluginRouteHref(app.pluginName, '/dashboard')}
			variant="light"
			size="xs"
			leftSection={<IconReceipt size={14} />}
		>
			用量
		</Button>
	)
}

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.HeaderActions,
			id: 'usage-billing-header-action',
			priority: 100,
			requireRunning: true,
			render: () => <HeaderAction />,
		},
		{
			point: ExtensionPoints.PluginTabs,
			id: 'usage-billing-dashboard',
			priority: 20,
			meta: { label: '用量总览', icon: <IconChartBar size={16} /> },
			render: () => <BillingPanel />,
		},
	],
	routes: [
		{
			definition: {
				path: '/dashboard',
				title: 'Usage Billing',
				icon: <IconReceipt size={18} stroke={1.7} />,
				addToNav: true,
				navPriority: 90,
			},
			render: () => <BillingDashboard />,
		},
	],
})

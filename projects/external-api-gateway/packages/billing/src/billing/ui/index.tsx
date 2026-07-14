import { Button } from '@mantine/core'
import { IconReceipt } from '@tabler/icons-react'
import { useWorkbenchHost } from '@pluxel/runtime/workbench/ui'
import { BillingDashboard, BillingPanel } from './panels'
import { billingPlugin } from './runtime'

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
			leftSection={<IconReceipt size={14} />}
		>
			用量
		</Button>
	)
}

export default billingPlugin.expose({ HeaderAction, BillingPanel, BillingDashboard })

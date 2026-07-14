import { Button } from '@mantine/core'
import { IconReceipt } from '@tabler/icons-react'
import { useWorkbenchHost } from '@pluxel/runtime/workbench/ui'
import { BillingDashboard, BillingPanel } from './panels'
import { billingUi } from './runtime'

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

export default billingUi.expose({ HeaderAction, BillingPanel, BillingDashboard })

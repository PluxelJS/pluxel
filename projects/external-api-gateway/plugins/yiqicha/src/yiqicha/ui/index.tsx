import { Button } from '@mantine/core'
import { IconServerCog } from '@tabler/icons-react'
import { useWorkbenchHost } from '@pluxel/runtime/workbench/ui'
import {
	YiqichaApiPanel,
	YiqichaDashboard,
	YiqichaHistoryPanel,
	YiqichaSettingsPanel,
} from './panels'
import { yiqichaUi } from './runtime'

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
			leftSection={<IconServerCog size={14} />}
		>
			YiQiCha Provider
		</Button>
	)
}

export default yiqichaUi.define({
	HeaderAction,
	YiqichaApiPanel,
	YiqichaDashboard,
	YiqichaHistoryPanel,
	YiqichaSettingsPanel,
})

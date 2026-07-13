import { Button } from '@mantine/core'
import { IconServerCog } from '@tabler/icons-react'
import {
	YiqichaApiPanel,
	YiqichaDashboard,
	YiqichaHistoryPanel,
	YiqichaSettingsPanel,
} from './panels'
import { yiqichaPlugin } from './runtime'

function pluginRouteHref(pluginName: string, path: string) {
	return `/plugins/${encodeURIComponent(pluginName)}${path}`
}

export function HeaderAction() {
	const app = yiqichaPlugin.use()
	return (
		<Button
			component="a"
			href={pluginRouteHref(app.target, '/dashboard')}
			variant="light"
			size="xs"
			leftSection={<IconServerCog size={14} />}
		>
			YiQiCha Provider
		</Button>
	)
}

export default yiqichaPlugin.define({
	HeaderAction,
	YiqichaApiPanel,
	YiqichaDashboard,
	YiqichaHistoryPanel,
	YiqichaSettingsPanel,
})

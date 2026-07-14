import { Button } from '@mantine/core'
import { IconTextRecognition } from '@tabler/icons-react'
import { useWorkbenchHost } from '@pluxel/runtime/workbench/ui'
import {
	ZhipuApiPanel,
	ZhipuDashboard,
	ZhipuHistoryPanel,
	ZhipuOcrPanel,
	ZhipuSettingsPanel,
} from './panels'
import { zhipuUi } from './runtime'

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
			leftSection={<IconTextRecognition size={14} />}
		>
			Zhipu Provider
		</Button>
	)
}

export default zhipuUi.expose({
	HeaderAction,
	ZhipuApiPanel,
	ZhipuDashboard,
	ZhipuHistoryPanel,
	ZhipuOcrPanel,
	ZhipuSettingsPanel,
})

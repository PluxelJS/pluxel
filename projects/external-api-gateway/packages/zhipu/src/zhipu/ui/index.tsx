import { Button } from '@mantine/core'
import { IconTextRecognition } from '@tabler/icons-react'
import {
	ZhipuApiPanel,
	ZhipuDashboard,
	ZhipuHistoryPanel,
	ZhipuOcrPanel,
	ZhipuSettingsPanel,
} from './panels'
import { zhipuPlugin } from './runtime'

function pluginRouteHref(pluginName: string, path: string) {
	return `/plugins/${encodeURIComponent(pluginName)}${path}`
}

export function HeaderAction() {
	const app = zhipuPlugin.use()
	return (
		<Button
			component="a"
			href={pluginRouteHref(app.target, '/dashboard')}
			variant="light"
			size="xs"
			leftSection={<IconTextRecognition size={14} />}
		>
			Zhipu Provider
		</Button>
	)
}

export default zhipuPlugin.define({
	HeaderAction,
	ZhipuApiPanel,
	ZhipuDashboard,
	ZhipuHistoryPanel,
	ZhipuOcrPanel,
	ZhipuSettingsPanel,
})

import { Button } from '@mantine/core'
import { definePluginUIModule, ExtensionPoints } from '@pluxel/runtime/web/ui'
import { IconCloudUpload, IconHistory, IconTextRecognition } from '@tabler/icons-react'
import { ZhipuDashboard, ZhipuHistoryPanel, ZhipuOcrPanel, ZhipuSettingsPanel } from './panels'
import { zhipuPlugin } from './runtime'

function pluginRouteHref(pluginName: string, path: string) {
	return `/plugins/${encodeURIComponent(pluginName)}${path}`
}

function HeaderAction() {
	const app = zhipuPlugin.useGlobal()
	return (
		<Button
			component="a"
			href={pluginRouteHref(app.pluginName, '/dashboard')}
			variant="light"
			size="xs"
			leftSection={<IconTextRecognition size={14} />}
		>
			Zhipu Provider
		</Button>
	)
}

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.HeaderActions,
			id: 'zhipu-provider-header-action',
			priority: 90,
			requireRunning: true,
			render: () => <HeaderAction />,
		},
		{
			point: ExtensionPoints.PluginTabs,
			id: 'zhipu-ocr-run',
			priority: 30,
			meta: { label: 'OCR', icon: <IconCloudUpload size={16} /> },
			render: () => <ZhipuOcrPanel />,
		},
		{
			point: ExtensionPoints.PluginTabs,
			id: 'zhipu-ocr-settings',
			priority: 20,
			meta: { label: '设置' },
			render: () => <ZhipuSettingsPanel />,
		},
		{
			point: ExtensionPoints.PluginTabs,
			id: 'zhipu-history',
			priority: 10,
			meta: { label: '历史', icon: <IconHistory size={16} /> },
			render: () => <ZhipuHistoryPanel />,
		},
	],
	routes: [
		{
			definition: {
				path: '/dashboard',
				title: 'Zhipu Provider',
				icon: <IconTextRecognition size={18} stroke={1.7} />,
				addToNav: true,
				navPriority: 80,
			},
			render: () => <ZhipuDashboard />,
		},
	],
})

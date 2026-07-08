import { Button } from '@mantine/core'
import { definePluginUIModule, ExtensionPoints } from '@pluxel/runtime/web/ui'
import { IconHistory, IconKey, IconSearch, IconServerCog } from '@tabler/icons-react'
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

function HeaderAction() {
	const app = yiqichaPlugin.useGlobal()
	return (
		<Button
			component="a"
			href={pluginRouteHref(app.pluginName, '/dashboard')}
			variant="light"
			size="xs"
			leftSection={<IconServerCog size={14} />}
		>
			YiQiCha Provider
		</Button>
	)
}

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.HeaderActions,
			id: 'yiqicha-provider-header-action',
			priority: 88,
			requireRunning: true,
			render: () => <HeaderAction />,
		},
		{
			point: ExtensionPoints.PluginTabs,
			id: 'yiqicha-api-test',
			priority: 30,
			meta: { label: '接口测试', icon: <IconSearch size={16} /> },
			render: () => <YiqichaApiPanel />,
		},
		{
			point: ExtensionPoints.PluginTabs,
			id: 'yiqicha-settings',
			priority: 20,
			meta: { label: '设置', icon: <IconKey size={16} /> },
			render: () => <YiqichaSettingsPanel />,
		},
		{
			point: ExtensionPoints.PluginTabs,
			id: 'yiqicha-history',
			priority: 10,
			meta: { label: '历史', icon: <IconHistory size={16} /> },
			render: () => <YiqichaHistoryPanel />,
		},
	],
	routes: [
		{
			definition: {
				path: '/dashboard',
				title: 'YiQiCha Provider',
				icon: <IconServerCog size={18} stroke={1.7} />,
				addToNav: true,
				navPriority: 78,
			},
			render: () => <YiqichaDashboard />,
		},
	],
})

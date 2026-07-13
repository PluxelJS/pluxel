import { definePluginUIModule, ExtensionPoints } from '@pluxel/runtime/web/ui'
import { IconBrandDiscord, IconSettings } from '@tabler/icons-react'
import { KookSettingsPanel } from './panel.tsx'

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.PluginTabs,
			id: 'kook-settings',
			priority: 50,
			meta: { label: 'KOOK 管理', icon: <IconSettings size={16} /> },
			render: () => <KookSettingsPanel />,
		},
	],
	routes: [
		{
			definition: {
				path: '/settings',
				title: 'KOOK Bot',
				icon: <IconBrandDiscord size={18} />,
				addToNav: true,
				navPriority: 70,
			},
			render: () => <KookSettingsPanel />,
		},
	],
})

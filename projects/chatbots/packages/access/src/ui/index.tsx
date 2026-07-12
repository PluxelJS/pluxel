import { definePluginUIModule, ExtensionPoints } from '@pluxel/runtime/web/ui'
import { IconShieldLock, IconUsers } from '@tabler/icons-react'
import { AccessPanel } from './panel.tsx'

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.PluginTabs,
			id: 'chat-access',
			priority: 45,
			meta: { label: '用户与权限', icon: <IconShieldLock size={16} /> },
			render: () => <AccessPanel />,
		},
	],
	routes: [
		{
			definition: {
				path: '/access',
				title: '用户与权限',
				icon: <IconUsers size={18} />,
				addToNav: true,
				navPriority: 66,
			},
			render: () => <AccessPanel />,
		},
	],
})

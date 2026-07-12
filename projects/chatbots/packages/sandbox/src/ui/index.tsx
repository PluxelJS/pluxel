import { definePluginUIModule, ExtensionPoints } from '@pluxel/runtime/web/ui'
import { IconMessageChatbot, IconTestPipe } from '@tabler/icons-react'
import { SandboxPanel } from './panel.tsx'
export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.PluginTabs,
			id: 'chat-sandbox',
			priority: 60,
			meta: { label: '消息沙箱', icon: <IconTestPipe size={16} /> },
			render: () => <SandboxPanel />,
		},
	],
	routes: [
		{
			definition: {
				path: '/sandbox',
				title: '消息沙箱',
				icon: <IconMessageChatbot size={18} />,
				addToNav: true,
				navPriority: 65,
			},
			render: () => <SandboxPanel />,
		},
	],
})

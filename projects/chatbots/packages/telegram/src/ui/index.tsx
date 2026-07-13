import { definePluginUIModule, ExtensionPoints } from '@pluxel/runtime/web/ui'
import { IconBrandTelegram, IconSettings } from '@tabler/icons-react'
import { TelegramSettingsPanel } from './panel.tsx'

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.PluginTabs,
			id: 'telegram-settings',
			priority: 50,
			meta: { label: 'Telegram 管理', icon: <IconSettings size={16} /> },
			render: () => <TelegramSettingsPanel />,
		},
	],
	routes: [
		{
			definition: {
				path: '/settings',
				title: 'Telegram Bot',
				icon: <IconBrandTelegram size={18} />,
				addToNav: true,
				navPriority: 69,
			},
			render: () => <TelegramSettingsPanel />,
		},
	],
})

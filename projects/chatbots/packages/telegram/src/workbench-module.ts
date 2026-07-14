import { workbench } from '@pluxel/runtime/workbench'
import type { TelegramWorkbenchRpc, TelegramSettingsDoc, TelegramStatusDoc } from './workbench.ts'

export const TelegramWorkbench = workbench.define({
	plugin: 'TelegramPlugin',
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
	model: {
		commands: workbench.model.rpc<TelegramWorkbenchRpc>(),
		settings: workbench.model.collection<TelegramSettingsDoc>(),
		status: workbench.model.collection<TelegramStatusDoc>(),
	},
	views: {
		TelegramSettingsPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['commands', 'settings', 'status'],
			priority: 50,
			label: 'Telegram 管理',
			icon: 'settings',
		}),
		TelegramSettingsRoute: workbench.view.route({
			path: '/settings',
			title: 'Telegram Bot',
			icon: 'brand-telegram',
			navigation: { priority: 69 },
			model: ['commands', 'settings', 'status'],
		}),
	},
})

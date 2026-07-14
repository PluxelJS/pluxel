import { workbench } from '@pluxel/runtime/workbench'
import type {
	TelegramSettingsDoc,
	TelegramStatusDoc,
	TelegramWorkbenchCommands,
} from './workbench-contract.ts'

export const TelegramWorkbench = workbench.define({
	plugin: 'TelegramPlugin',
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
	model: {
		commands: workbench.model.rpc<TelegramWorkbenchCommands>(),
		settings: workbench.model.collection<TelegramSettingsDoc>(),
		status: workbench.model.collection<TelegramStatusDoc>(),
	},
	views: (model) => ({
		Settings: workbench.view.remote({
			model: [model.commands, model.settings, model.status],
			placements: [
				workbench.place.slot({
					slot: workbench.slot.PluginTabs,
					priority: 50,
					label: 'Telegram 管理',
					icon: 'settings',
				}),
				workbench.place.route({
					path: '/settings',
					title: 'Telegram Bot',
					icon: 'brand-telegram',
					navigation: { priority: 69 },
				}),
			],
		}),
	}),
})

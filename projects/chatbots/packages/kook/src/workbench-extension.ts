import { workbench } from '@pluxel/runtime/workbench'
import type { KookSettingsDoc, KookStatusDoc, KookWorkbenchCommands } from './workbench-contract.ts'

export const KookWorkbench = workbench.define({
	plugin: 'KookPlugin',
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
	model: {
		commands: workbench.model.rpc<KookWorkbenchCommands>(),
		settings: workbench.model.collection<KookSettingsDoc>(),
		status: workbench.model.collection<KookStatusDoc>(),
	},
	views: (model) => ({
		Settings: workbench.view.remote({
			model: [model.commands, model.settings, model.status],
			placements: [
				workbench.place.slot({
					slot: workbench.slot.PluginTabs,
					priority: 50,
					label: 'KOOK 管理',
					icon: 'settings',
				}),
				workbench.place.route({
					path: '/settings',
					title: 'KOOK Bot',
					icon: 'brand-discord',
					navigation: { priority: 70 },
				}),
			],
		}),
	}),
})

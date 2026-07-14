import { workbench } from '@pluxel/runtime/workbench'
import type { KookWorkbenchRpc, KookSettingsDoc, KookStatusDoc } from './workbench.ts'

export const KookWorkbench = workbench.define({
	plugin: 'KookPlugin',
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
	model: {
		commands: workbench.model.rpc<KookWorkbenchRpc>(),
		settings: workbench.model.collection<KookSettingsDoc>(),
		status: workbench.model.collection<KookStatusDoc>(),
	},
	views: {
		KookSettingsPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['commands', 'settings', 'status'],
			priority: 50,
			label: 'KOOK 管理',
			icon: 'settings',
		}),
		KookSettingsRoute: workbench.view.route({
			path: '/settings',
			title: 'KOOK Bot',
			icon: 'brand-discord',
			navigation: { priority: 70 },
			model: ['commands', 'settings', 'status'],
		}),
	},
})

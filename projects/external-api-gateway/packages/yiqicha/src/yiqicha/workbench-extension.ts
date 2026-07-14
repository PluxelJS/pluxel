import { workbench } from '@pluxel/runtime/workbench'
import type { YiqichaSettingsDoc, YiqichaStatusDoc, YiqichaTestRunDoc } from './contracts.ts'
import type { YiqichaProviderRpc } from './plugin.ts'

export const YiqichaWorkbench = workbench.define({
	plugin: 'YiqichaProviderPlugin',
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
	model: {
		commands: workbench.model.rpc<YiqichaProviderRpc>(),
		settings: workbench.model.collection<YiqichaSettingsDoc>(),
		status: workbench.model.collection<YiqichaStatusDoc>(),
		history: workbench.model.collection<YiqichaTestRunDoc>(),
	},
	views: (model) => ({
		HeaderAction: workbench.view.remote({
			placements: [
				workbench.place.slot({ slot: workbench.slot.GlobalHeaderActions, priority: 90 }),
			],
		}),
		YiqichaApiPanel: workbench.view.remote({
			model: [model.commands, model.settings, model.status],
			placements: [
				workbench.place.slot({
					slot: workbench.slot.PluginTabs,
					priority: 30,
					label: '接口测试',
					icon: 'search',
				}),
			],
		}),
		YiqichaSettingsPanel: workbench.view.remote({
			model: [model.commands, model.settings, model.status],
			placements: [
				workbench.place.slot({
					slot: workbench.slot.PluginTabs,
					priority: 20,
					label: '设置',
				}),
			],
		}),
		YiqichaHistoryPanel: workbench.view.remote({
			model: [model.commands, model.history],
			placements: [
				workbench.place.slot({
					slot: workbench.slot.PluginTabs,
					priority: 10,
					label: '历史',
					icon: 'history',
				}),
			],
		}),
		YiqichaDashboard: workbench.view.remote({
			model: [model.commands, model.settings, model.status, model.history],
			placements: [
				workbench.place.route({
					path: '/dashboard',
					title: 'YiQiCha Provider',
					icon: 'building',
					navigation: { priority: 78 },
				}),
			],
		}),
	}),
})

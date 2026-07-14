import { workbench } from '@pluxel/runtime/workbench'
import type { ZhipuSettingsDoc, ZhipuStatusDoc, ZhipuTestRunDoc } from './contracts.ts'
import type { ZhipuProviderRpc } from './plugin.ts'

export const ZhipuWorkbench = workbench.define({
	plugin: 'ZhipuProviderPlugin',
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
	model: {
		commands: workbench.model.rpc<ZhipuProviderRpc>(),
		settings: workbench.model.collection<ZhipuSettingsDoc>(),
		status: workbench.model.collection<ZhipuStatusDoc>(),
		history: workbench.model.collection<ZhipuTestRunDoc>(),
	},
	views: (model) => ({
		HeaderAction: workbench.view.remote({
			placements: [
				workbench.place.slot({ slot: workbench.slot.GlobalHeaderActions, priority: 90 }),
			],
		}),
		ZhipuOcrPanel: workbench.view.remote({
			model: [model.commands, model.settings, model.status],
			placements: [
				workbench.place.slot({
					slot: workbench.slot.PluginTabs,
					priority: 30,
					label: 'OCR',
					icon: 'cloud-upload',
				}),
			],
		}),
		ZhipuApiPanel: workbench.view.remote({
			model: [model.commands, model.settings, model.status],
			placements: [
				workbench.place.slot({
					slot: workbench.slot.PluginTabs,
					priority: 25,
					label: '模型/工具',
					icon: 'plug-connected',
				}),
			],
		}),
		ZhipuSettingsPanel: workbench.view.remote({
			model: [model.commands, model.settings, model.status],
			placements: [
				workbench.place.slot({
					slot: workbench.slot.PluginTabs,
					priority: 20,
					label: '设置',
				}),
			],
		}),
		ZhipuHistoryPanel: workbench.view.remote({
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
		ZhipuDashboard: workbench.view.remote({
			model: [model.commands, model.settings, model.status, model.history],
			placements: [
				workbench.place.route({
					path: '/dashboard',
					title: 'Zhipu Provider',
					icon: 'text-recognition',
					navigation: { priority: 80 },
				}),
			],
		}),
	}),
})

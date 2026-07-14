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
	views: {
		HeaderAction: workbench.view.slot({
			slot: workbench.slot.GlobalHeaderActions,
			model: ['status'],
			priority: 90,
		}),
		ZhipuOcrPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['commands', 'settings', 'status'],
			priority: 30,
			label: 'OCR',
			icon: 'cloud-upload',
		}),
		ZhipuApiPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['commands', 'settings', 'status'],
			priority: 25,
			label: '模型/工具',
			icon: 'plug-connected',
		}),
		ZhipuSettingsPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['commands', 'settings', 'status'],
			priority: 20,
			label: '设置',
		}),
		ZhipuHistoryPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['commands', 'history'],
			priority: 10,
			label: '历史',
			icon: 'history',
		}),
		ZhipuDashboard: workbench.view.route({
			path: '/dashboard',
			title: 'Zhipu Provider',
			icon: 'text-recognition',
			navigation: { priority: 80 },
			model: ['commands', 'settings', 'status', 'history'],
		}),
	},
})

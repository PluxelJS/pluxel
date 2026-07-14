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
	views: {
		HeaderAction: workbench.view.slot({
			slot: workbench.slot.GlobalHeaderActions,
			model: ['status'],
			priority: 90,
		}),
		YiqichaApiPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['commands', 'settings', 'status'],
			priority: 30,
			label: '接口测试',
			icon: 'search',
		}),
		YiqichaSettingsPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['commands', 'settings', 'status'],
			priority: 20,
			label: '设置',
		}),
		YiqichaHistoryPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['commands', 'history'],
			priority: 10,
			label: '历史',
			icon: 'history',
		}),
		YiqichaDashboard: workbench.view.route({
			path: '/dashboard',
			title: 'YiQiCha Provider',
			icon: 'building',
			navigation: { priority: 78 },
			model: ['commands', 'settings', 'status', 'history'],
		}),
	},
})

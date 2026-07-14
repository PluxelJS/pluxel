import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import type { YiqichaSettingsDoc, YiqichaStatusDoc, YiqichaTestRunDoc } from './contracts.ts'
export interface YiqichaProviderCommands {
	saveSettings(input: {
		appkey?: string
		secretKey?: string
		baseUrl?: string
	}): Promise<YiqichaSettingsDoc>
	clearSecrets(): Promise<unknown>
	testConnection(input?: {
		userId?: string
		api?: string
		keyword?: string
	}): Promise<{ message: string }>
	clearHistory(): Promise<unknown>
}

export const YiqichaUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<YiqichaProviderCommands>(),
		settings: workbenchContract.collection<YiqichaSettingsDoc>(),
		status: workbenchContract.collection<YiqichaStatusDoc>(),
		history: workbenchContract.collection<YiqichaTestRunDoc>(),
	},
	views: {
		HeaderAction: {
			placements: [workbenchContract.slot(workbenchContract.slots.GlobalHeaderActions)],
		},
		YiqichaApiPanel: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 30,
					label: '接口测试',
					icon: workbenchContract.icons.Search,
				}),
			],
		},
		YiqichaSettingsPanel: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 20,
					label: '设置',
				}),
			],
		},
		YiqichaHistoryPanel: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 10,
					label: '历史',
					icon: workbenchContract.icons.History,
				}),
			],
		},
		YiqichaDashboard: {
			placements: [
				workbenchContract.route('/dashboard', {
					title: 'YiQiCha Provider',
					icon: workbenchContract.icons.Building,
					order: 78,
				}),
			],
		},
	},
})

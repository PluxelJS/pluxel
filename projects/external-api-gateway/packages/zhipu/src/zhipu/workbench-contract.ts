import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import type { ZhipuSettingsDoc, ZhipuStatusDoc, ZhipuTestRunDoc } from './contracts.ts'
export interface ZhipuProviderCommands {
	saveSettings(input: { apiKey?: string; baseUrl?: string }): Promise<ZhipuSettingsDoc>
	clearApiKey(): Promise<unknown>
	testConnection(userId?: string): Promise<{ message: string }>
	clearHistory(): Promise<unknown>
}

export const ZhipuUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<ZhipuProviderCommands>(),
		settings: workbenchContract.collection<ZhipuSettingsDoc>(),
		status: workbenchContract.collection<ZhipuStatusDoc>(),
		history: workbenchContract.collection<ZhipuTestRunDoc>(),
	},
	views: {
		HeaderAction: {
			placements: [workbenchContract.slot(workbenchContract.slots.GlobalHeaderActions)],
		},
		ZhipuOcrPanel: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 30,
					label: 'OCR',
					icon: workbenchContract.icons.CloudUpload,
				}),
			],
		},
		ZhipuApiPanel: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 25,
					label: '模型/工具',
					icon: workbenchContract.icons.PlugConnected,
				}),
			],
		},
		ZhipuSettingsPanel: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, { order: 20, label: '设置' }),
			],
		},
		ZhipuHistoryPanel: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 10,
					label: '历史',
					icon: workbenchContract.icons.History,
				}),
			],
		},
		ZhipuDashboard: {
			placements: [
				workbenchContract.route('/dashboard', {
					title: 'Zhipu Provider',
					icon: workbenchContract.icons.TextRecognition,
					order: 80,
				}),
			],
		},
	},
})

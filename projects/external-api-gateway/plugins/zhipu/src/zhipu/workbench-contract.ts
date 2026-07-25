import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { jsonObjectSchema } from '@repo/external-api-gateway-shared/wire-schema'
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
		settings: workbenchContract.liveQuery({ row: jsonObjectSchema<ZhipuSettingsDoc>(), key: 'id' }),
		status: workbenchContract.liveQuery({ row: jsonObjectSchema<ZhipuStatusDoc>(), key: 'id' }),
		history: workbenchContract.liveQuery({ row: jsonObjectSchema<ZhipuTestRunDoc>(), key: 'id' }),
	},
	views: {
		ZhipuOcrPanel: {
			placements: [
				workbenchContract.tab({
					order: 30,
					label: 'OCR',
					icon: workbenchContract.icons.CloudUpload,
				}),
			],
		},
		ZhipuApiPanel: {
			placements: [
				workbenchContract.tab({
					order: 25,
					label: '模型/工具',
					icon: workbenchContract.icons.PlugConnected,
				}),
			],
		},
		ZhipuSettingsPanel: {
			placements: [workbenchContract.tab({ order: 20, label: '设置' })],
		},
		ZhipuHistoryPanel: {
			placements: [
				workbenchContract.tab({
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

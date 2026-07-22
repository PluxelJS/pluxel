import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { jsonObjectSchema } from '@repo/chatbots-adapter-kit/wire-schema'

export type TelegramSettingsDoc = {
	id: string
	tokenPreview: string
	apiBase: string
	updatedAt: number
}

export type TelegramStatusDoc = {
	id: string
	phase: 'offline' | 'connecting' | 'online' | 'error'
	botId: string | null
	username: string | null
	lastError: string | null
	startedAt: number
	connectedAt: number | null
	lastPollAt: number | null
	lastUpdateId: number | null
	lastUpdateAt: number | null
	consecutiveFailures: number
	currentBackoffMs: number
	updatedAt: number
}

export interface TelegramWorkbenchCommands {
	upsertBot(input: { id: string; token?: string; apiBase?: string }): Promise<{ ok: true }>
	removeBot(id: string): Promise<{ ok: true }>
	testBot(id: string): Promise<{ ok: boolean; message: string }>
	reconnectBot(id: string): Promise<unknown>
	disconnectBot(id: string): Promise<unknown>
}

export const TelegramUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<TelegramWorkbenchCommands>(),
		settings: workbenchContract.liveQuery({
			row: jsonObjectSchema<TelegramSettingsDoc>(),
			key: 'id',
		}),
		status: workbenchContract.liveQuery({ row: jsonObjectSchema<TelegramStatusDoc>(), key: 'id' }),
	},
	views: {
		Overview: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 50,
					label: 'Telegram 状态',
					icon: workbenchContract.icons.Settings,
				}),
			],
		},
		Manager: {
			placements: [
				workbenchContract.route('/settings', {
					title: 'Telegram Bots',
					icon: workbenchContract.icons.BrandTelegram,
					navigation: {
						label: 'Telegram',
						group: {
							id: 'bots',
							label: 'Bots',
							icon: workbenchContract.icons.MessageChatbot,
						},
					},
					order: 65,
				}),
			],
		},
	},
})

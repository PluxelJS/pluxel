import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import type {
	BotAdminAccount,
	BotAdminCommands,
	BotAdminEvents,
} from '@repo/chatbots-platform-kit/bot-admin'

/** Bounded polling diagnostics sent to the optional management plane. */
export type TelegramBotDiagnostics = {
	startedAt: number
	lastPollAt: number | null
	lastUpdateId: number | null
	lastUpdateAt: number | null
	offset: number
	consecutiveFailures: number
	currentBackoffMs: number
}

export type TelegramAdminAccount = BotAdminAccount<TelegramBotDiagnostics>
export type TelegramWorkbenchEvents = BotAdminEvents<TelegramAdminAccount>
export type TelegramWorkbenchCommands = BotAdminCommands

export const TelegramUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<TelegramWorkbenchCommands>(),
		state: workbenchContract.events<TelegramWorkbenchEvents>(),
	},
	views: {
		Overview: {
			placements: [
				workbenchContract.tab({
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
		Account: {
			placements: [
				workbenchContract.route('/accounts/:accountId', {
					title: 'Telegram Bot',
					navigation: false,
				}),
			],
		},
		Create: {
			placements: [
				workbenchContract.route('/create', {
					title: 'New Telegram Bot',
					navigation: false,
				}),
			],
		},
	},
})

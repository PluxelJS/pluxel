import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import type {
	BotAdminAccount,
	BotAdminCommands,
	BotAdminEvents,
} from '@repo/chatbots-platform-kit/bot-admin'

/** Bounded Discord gateway diagnostics sent to the optional management plane. */
export type DiscordBotDiagnostics = {
	startedAt: number
	epoch: number
	applicationId: string | null
	guilds: number
	lastHealthyAt: number | null
}

export type DiscordAdminAccount = BotAdminAccount<DiscordBotDiagnostics>
export type DiscordWorkbenchEvents = BotAdminEvents<DiscordAdminAccount>
export type DiscordWorkbenchCommands = BotAdminCommands

export const DiscordUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<DiscordWorkbenchCommands>(),
		state: workbenchContract.events<DiscordWorkbenchEvents>(),
	},
	views: {
		Overview: {
			placements: [
				workbenchContract.tab({
					order: 50,
					label: 'Discord 状态',
					icon: workbenchContract.icons.Settings,
				}),
			],
		},
		Manager: {
			placements: [
				workbenchContract.route('/settings', {
					title: 'Discord Bots',
					icon: workbenchContract.icons.BrandDiscord,
					navigation: {
						label: 'Discord',
						group: {
							id: 'bots',
							label: 'Bots',
							icon: workbenchContract.icons.MessageChatbot,
						},
					},
					order: 67,
				}),
			],
		},
		Account: {
			placements: [
				workbenchContract.route('/accounts/:accountId', {
					title: 'Discord Bot',
					navigation: false,
				}),
			],
		},
		Create: {
			placements: [
				workbenchContract.route('/create', {
					title: 'New Discord Bot',
					navigation: false,
				}),
			],
		},
	},
})

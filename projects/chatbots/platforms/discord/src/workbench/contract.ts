import { workbenchContract } from '@pluxel/runtime/workbench/contract'

export type DiscordAdminAccount = Readonly<{
	id: string
	tokenPreview: string
	state: 'connecting' | 'ready' | 'failed' | 'stopped'
	username?: string
	applicationId?: string
	guilds: number
	epoch: number
	connectedAt?: number
	lastHealthyAt?: number
	failureMessage?: string
}>

export interface DiscordAdminCommands {
	upsertBot(input: { id: string; token?: string }): Promise<void>
	removeBot(id: string): Promise<void>
	reconnectBot(id: string): Promise<void>
	disconnectBot(id: string): Promise<void>
}

export type DiscordAdminEvents = {
	snapshot: { accounts: readonly DiscordAdminAccount[] }
}

export const DiscordUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<DiscordAdminCommands>(),
		state: workbenchContract.events<DiscordAdminEvents>(),
	},
	views: {
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
	},
})

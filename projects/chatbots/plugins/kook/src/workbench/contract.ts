import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { WretchWorkbenchPort } from '@pluxel/wretch/workbench'
import type {
	BotAdminAccount,
	BotAdminCommands,
	BotAdminEvents,
} from '@repo/chatbots-platform-kit/bot-admin'

/** Bounded gateway diagnostics sent to the optional management plane. */
export type KookBotDiagnostics = {
	startedAt: number
	gatewayPhase: 'idle' | 'connecting' | 'resuming' | 'online' | 'backoff' | 'stopped'
	lastSequence: number
	bufferedEvents: number
	lastEventAt: number | null
	lastPongAt: number | null
	connectAttempts: number
	reconnectAttempts: number
	resumeAttempts: number
	eventsReceived: number
	pingSent: number
	pongReceived: number
	duplicateEvents: number
	outOfOrderEvents: number
	bufferOverflows: number
	currentBackoffMs: number
}

export type KookAdminAccount = BotAdminAccount<KookBotDiagnostics>
export type KookWorkbenchEvents = BotAdminEvents<KookAdminAccount>
export type KookWorkbenchCommands = BotAdminCommands

export const KookUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<KookWorkbenchCommands>(),
		httpSettings: WretchWorkbenchPort.resources.settings,
		state: workbenchContract.events<KookWorkbenchEvents>(),
	},
	views: {
		Overview: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 50,
					label: 'KOOK 状态',
					icon: workbenchContract.icons.Settings,
				}),
			],
		},
		Manager: {
			placements: [
				workbenchContract.route('/settings', {
					title: 'KOOK Bots',
					icon: workbenchContract.icons.BrandDiscord,
					navigation: {
						label: 'KOOK',
						group: {
							id: 'bots',
							label: 'Bots',
							icon: workbenchContract.icons.MessageChatbot,
						},
					},
					order: 66,
				}),
			],
		},
		Account: {
			placements: [
				workbenchContract.route('/accounts/:accountId', {
					title: 'KOOK Bot',
					navigation: false,
				}),
			],
		},
		Create: {
			placements: [
				workbenchContract.route('/create', {
					title: 'New KOOK Bot',
					navigation: false,
				}),
			],
		},
	},
	outlets: ({ resources }) => ({
		Http: {
			port: WretchWorkbenchPort,
			placement: workbenchContract.slot(workbenchContract.slots.PluginTabs, {
				order: 49,
				label: 'HTTP',
				icon: workbenchContract.icons.Settings,
			}),
			provide: { settings: resources.httpSettings },
		},
	}),
})

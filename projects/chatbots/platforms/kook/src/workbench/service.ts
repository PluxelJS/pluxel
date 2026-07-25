import {
	attachBotAdminState,
	BotAdminRpc,
	maskBotSecret,
} from '@repo/chatbots-platform-kit/bot-admin'
import type { Result } from '../api/types.ts'
import type { KookBotManager } from '../bot/manager.ts'
import type { KookAdminAccount, KookWorkbenchEvents } from './contract.ts'

export class KookWorkbenchRpc extends BotAdminRpc {
	constructor(bots: KookBotManager) {
		super({
			upsert: (input) => bots.upsert(input),
			remove: (id) => bots.remove(id),
			reconnect: (id) => bots.reconnect(id),
			disconnect: (id) => bots.disconnect(id),
			test: async (id) => {
				const identity = unwrap(await bots.bots.require(id).getUserMe())
				return `KOOK Bot ${identity.username ?? identity.id} 鉴权成功。`
			},
		})
	}
}

export function attachKookWorkbenchState(
	bots: KookBotManager,
	events: {
		emit<Key extends keyof KookWorkbenchEvents>(event: Key, payload: KookWorkbenchEvents[Key]): void
		signal: AbortSignal
	},
): () => void {
	return attachBotAdminState(
		() => kookAdminAccounts(bots),
		(listener) => bots.subscribe(listener),
		events,
	)
}

function kookAdminAccounts(bots: KookBotManager): KookAdminAccount[] {
	return bots.listAccounts().map(({ config, bot }) => {
		const status = bot.$.status
		return {
			id: config.id,
			apiBase: config.apiBase,
			tokenPreview: maskBotSecret(config.token),
			phase: status.phase === 'destroyed' ? 'offline' : status.phase,
			identityId: status.botId,
			username: status.username,
			lastError: status.lastError,
			connectedAt: status.connectedAt,
			updatedAt: status.updatedAt,
			diagnostics: {
				startedAt: status.startedAt,
				gatewayPhase: status.gateway.phase,
				lastSequence: status.gateway.lastSequence,
				bufferedEvents: status.gateway.bufferedEvents,
				lastEventAt: status.gateway.timestamps.lastEventAt,
				lastPongAt: status.gateway.timestamps.lastPongAt,
				connectAttempts: status.gateway.counters.connectAttempts,
				reconnectAttempts: status.gateway.counters.reconnectAttempts,
				resumeAttempts: status.gateway.counters.resumeAttempts,
				eventsReceived: status.gateway.counters.eventsReceived,
				pingSent: status.gateway.counters.pingSent,
				pongReceived: status.gateway.counters.pongReceived,
				duplicateEvents: status.gateway.counters.duplicateEvents,
				outOfOrderEvents: status.gateway.counters.outOfOrderEvents,
				bufferOverflows: status.gateway.counters.bufferOverflows,
				currentBackoffMs: status.gateway.currentBackoffMs,
			},
		}
	})
}

function unwrap<Value>(result: Result<Value>): Value {
	if (result.ok === true) return result.data
	throw new Error(`KOOK API error ${result.code}: ${result.message}`)
}

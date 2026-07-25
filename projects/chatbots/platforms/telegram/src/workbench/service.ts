import {
	attachBotAdminState,
	BotAdminRpc,
	maskBotSecret,
} from '@repo/chatbots-platform-kit/bot-admin'
import type { TelegramBotManager } from '../bot/manager.ts'
import type { TelegramAdminAccount, TelegramWorkbenchEvents } from './contract.ts'

export class TelegramWorkbenchRpc extends BotAdminRpc {
	constructor(bots: TelegramBotManager) {
		super({
			upsert: (input) => bots.upsert(input),
			remove: (id) => bots.remove(id),
			reconnect: (id) => bots.reconnect(id),
			disconnect: (id) => bots.disconnect(id),
			test: async (id) => {
				const identity = await bots.bots.require(id).getMe()
				return `Telegram Bot @${identity.username ?? identity.id} 鉴权成功。`
			},
		})
	}
}

export function attachTelegramWorkbenchState(
	bots: TelegramBotManager,
	events: {
		emit<Key extends keyof TelegramWorkbenchEvents>(
			event: Key,
			payload: TelegramWorkbenchEvents[Key],
		): void
		signal: AbortSignal
	},
): () => void {
	return attachBotAdminState(
		() => telegramAdminAccounts(bots),
		(listener) => bots.subscribe(listener),
		events,
	)
}

function telegramAdminAccounts(bots: TelegramBotManager): TelegramAdminAccount[] {
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
				lastPollAt: status.polling.lastPollAt,
				lastUpdateId: status.polling.lastUpdateId,
				lastUpdateAt: status.polling.lastUpdateAt,
				offset: status.polling.offset,
				consecutiveFailures: status.polling.consecutiveFailures,
				currentBackoffMs: status.polling.currentBackoffMs,
			},
		}
	})
}

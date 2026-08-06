import { REST, Routes } from 'discord.js'
import {
	attachBotAdminState,
	BotAdminRpc,
	maskBotSecret,
} from '@repo/chatbots-platform-kit/bot-admin'
import type { DiscordBotManager } from '../bot/manager.ts'
import { resolveDiscordRestOptions } from '../bot/rest.ts'
import type { DiscordAdminAccount, DiscordWorkbenchEvents } from './contract.ts'

export class DiscordWorkbenchRpc extends BotAdminRpc {
	constructor(bots: DiscordBotManager) {
		super({
			upsert: (input) => bots.upsert(input),
			remove: (id) => bots.remove(id),
			reconnect: (id) => bots.reconnect(id),
			disconnect: (id) => bots.disconnect(id),
			test: async (id) => {
				const managed = bots.listAccounts().find((account) => account.config.id === id)
				if (!managed) throw new Error(`Bot is not configured: ${id}`)
				const identity = parseDiscordIdentity(
					await new REST(resolveDiscordRestOptions(managed.config.apiBase))
					.setToken(managed.config.token)
					.get(Routes.user()),
				)
				return `Discord Bot ${identity.username} (${identity.id}) 鉴权成功。`
			},
		})
	}
}

function parseDiscordIdentity(value: unknown): { id: string; username: string } {
	if (!value || typeof value !== 'object') throw new Error('Discord returned an invalid identity')
	const identity = value as { id?: unknown; username?: unknown }
	if (typeof identity.id !== 'string' || typeof identity.username !== 'string')
		throw new Error('Discord returned an invalid identity')
	return { id: identity.id, username: identity.username }
}

export function attachDiscordAdminState(
	bots: DiscordBotManager,
	events: {
		emit<Key extends keyof DiscordWorkbenchEvents>(
			event: Key,
			payload: DiscordWorkbenchEvents[Key],
		): void
		signal: AbortSignal
	},
): () => void {
	return attachBotAdminState(
		() => discordAdminAccounts(bots),
		(listener) => bots.subscribe(listener),
		events,
	)
}

function discordAdminAccounts(bots: DiscordBotManager): DiscordAdminAccount[] {
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
				epoch: status.gateway.epoch,
				applicationId: status.gateway.applicationId,
				guilds: status.gateway.guilds,
				lastHealthyAt: status.gateway.lastHealthyAt,
			},
		}
	})
}

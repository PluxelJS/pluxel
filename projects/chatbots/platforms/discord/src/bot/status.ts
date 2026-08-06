import type { BotPhase, BotStatus } from '@repo/chatbots-platform-kit/bot-status'

export type DiscordBotPhase = BotPhase

/** Bounded Discord gateway diagnostics owned by one managed Bot. */
export type DiscordGatewaySnapshot = Readonly<{
	epoch: number
	applicationId: string | null
	guilds: number
	lastHealthyAt: number | null
}>

/** Immutable current lifecycle and gateway snapshot for one Discord Bot. */
export type DiscordBotStatus = Readonly<BotStatus & { gateway: DiscordGatewaySnapshot }>

export function createDiscordBotStatus(): DiscordBotStatus {
	const now = Date.now()
	return Object.freeze({
		phase: 'offline',
		botId: null,
		username: null,
		lastError: null,
		startedAt: now,
		connectedAt: null,
		updatedAt: now,
		gateway: createDiscordGatewaySnapshot(),
	})
}

export function updateDiscordBotStatus(
	current: DiscordBotStatus,
	patch: Partial<Omit<DiscordBotStatus, 'updatedAt' | 'gateway'>> & {
		gateway?: Partial<DiscordGatewaySnapshot>
	},
): DiscordBotStatus {
	return Object.freeze({
		...current,
		...patch,
		updatedAt: Date.now(),
		gateway: createDiscordGatewaySnapshot({ ...current.gateway, ...patch.gateway }),
	})
}

function createDiscordGatewaySnapshot(
	patch: Partial<DiscordGatewaySnapshot> = {},
): DiscordGatewaySnapshot {
	return Object.freeze({
		epoch: patch.epoch ?? 0,
		applicationId: patch.applicationId ?? null,
		guilds: patch.guilds ?? 0,
		lastHealthyAt: patch.lastHealthyAt ?? null,
	})
}

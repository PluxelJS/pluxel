import type { BotPhase, BotStatus } from '@repo/chatbots-platform-kit/bot-status'
import type { KookGatewaySnapshot } from './gateway.ts'

/** Lifecycle phase reported by a managed KOOK Bot. */
export type KookBotPhase = BotPhase

export type KookBotStatus = Readonly<BotStatus & { gateway: KookGatewaySnapshot }>

export function createKookBotStatus(gateway: KookGatewaySnapshot): KookBotStatus {
	const now = Date.now()
	return Object.freeze({
		phase: 'offline',
		botId: null,
		username: null,
		lastError: null,
		startedAt: now,
		connectedAt: null,
		updatedAt: now,
		gateway,
	})
}

export function updateKookBotStatus(
	current: KookBotStatus,
	patch: Partial<Omit<KookBotStatus, 'updatedAt'>>,
): KookBotStatus {
	return Object.freeze({ ...current, ...patch, updatedAt: Date.now() })
}

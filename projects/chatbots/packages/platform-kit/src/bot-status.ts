/** Shared lifecycle vocabulary for every configured platform Bot. */
export type BotPhase = 'offline' | 'connecting' | 'online' | 'error' | 'destroyed'

/**
 * Immutable fields present in every platform Bot status snapshot.
 * Platform-owned bounded diagnostics are added by the concrete status type.
 */
export type BotStatus = Readonly<{
	phase: BotPhase
	botId: string | null
	username: string | null
	lastError: string | null
	startedAt: number
	connectedAt: number | null
	updatedAt: number
}>

export type TelegramBotPhase = 'offline' | 'connecting' | 'online' | 'error' | 'destroyed'

export type TelegramPollingSnapshot = Readonly<{
	offset: number
	consecutiveFailures: number
	currentBackoffMs: number
	lastPollAt: number | null
	lastUpdateId: number | null
	lastUpdateAt: number | null
}>

export type TelegramBotStatus = Readonly<{
	phase: TelegramBotPhase
	botId: string | null
	username: string | null
	lastError: string | null
	startedAt: number
	connectedAt: number | null
	updatedAt: number
	polling: TelegramPollingSnapshot
}>

export function createTelegramBotStatus(): TelegramBotStatus {
	const now = Date.now()
	return Object.freeze({
		phase: 'offline',
		botId: null,
		username: null,
		lastError: null,
		startedAt: now,
		connectedAt: null,
		updatedAt: now,
		polling: createPollingSnapshot(),
	})
}

export function updateTelegramBotStatus(
	current: TelegramBotStatus,
	patch: Partial<Omit<TelegramBotStatus, 'updatedAt' | 'polling'>> & {
		polling?: Partial<TelegramPollingSnapshot>
	},
): TelegramBotStatus {
	return Object.freeze({
		...current,
		...patch,
		updatedAt: Date.now(),
		polling: createPollingSnapshot({ ...current.polling, ...patch.polling }),
	})
}

function createPollingSnapshot(
	patch: Partial<TelegramPollingSnapshot> = {},
): TelegramPollingSnapshot {
	return Object.freeze({
		offset: patch.offset ?? 0,
		consecutiveFailures: patch.consecutiveFailures ?? 0,
		currentBackoffMs: patch.currentBackoffMs ?? 0,
		lastPollAt: patch.lastPollAt ?? null,
		lastUpdateId: patch.lastUpdateId ?? null,
		lastUpdateAt: patch.lastUpdateAt ?? null,
	})
}

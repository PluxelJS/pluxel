export type TelegramSettingsDoc = {
	id: string
	tokenPreview: string
	apiBase: string
	updatedAt: number
}

export type TelegramStatusDoc = {
	id: string
	phase: 'offline' | 'connecting' | 'online' | 'error'
	botId: string | null
	username: string | null
	lastError: string | null
	startedAt: number
	connectedAt: number | null
	lastUpdateId: number | null
	lastUpdateAt: number | null
	consecutiveFailures: number
	currentBackoffMs: number
	updatedAt: number
}

export interface TelegramWorkbenchCommands {
	upsertBot(input: { id: string; token?: string; apiBase?: string }): Promise<{ ok: true }>
	removeBot(id: string): Promise<{ ok: true }>
	testBot(id: string): Promise<{ ok: boolean; message: string }>
	reconnectBot(id: string): Promise<unknown>
	disconnectBot(id: string): Promise<unknown>
}

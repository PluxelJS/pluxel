export type KookSettingsDoc = {
	id: string
	tokenPreview: string
	apiBase: string
	updatedAt: number
}

export type KookStatusDoc = {
	id: string
	phase: 'offline' | 'connecting' | 'online' | 'error'
	botId: string | null
	username: string | null
	lastError: string | null
	startedAt: number
	connectedAt: number | null
	gatewayPhase: 'idle' | 'connecting' | 'resuming' | 'online' | 'backoff' | 'stopped'
	lastSequence: number
	bufferedEvents: number
	lastEventAt: number | null
	reconnectAttempts: number
	resumeAttempts: number
	duplicateEvents: number
	outOfOrderEvents: number
	bufferOverflows: number
	currentBackoffMs: number
	updatedAt: number
}

export interface KookWorkbenchCommands {
	upsertBot(input: { id: string; token?: string; apiBase?: string }): Promise<{ ok: true }>
	removeBot(id: string): Promise<{ ok: true }>
	testBot(id: string): Promise<{ ok: boolean; message: string }>
	reconnectBot(id: string): Promise<unknown>
	disconnectBot(id: string): Promise<unknown>
}

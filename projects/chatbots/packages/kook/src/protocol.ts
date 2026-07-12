export type KookSettingsDoc = {
	id: string
	accountId: string
	hasToken: boolean
	tokenPreview: string | null
	apiBase: string
	updatedAt: number
}
export type KookStatusDoc = {
	id: string
	accountId: string
	phase: 'unconfigured' | 'offline' | 'connecting' | 'online' | 'error'
	botId: string | null
	username: string | null
	lastError: string | null
	startedAt: number
	connectedAt: number | null
	gatewayPhase: import('./gateway.ts').KookGatewayPhase
	lastSequence: number
	lastEventAt: number | null
	reconnectAttempts: number
	currentBackoffMs: number
	updatedAt: number
}
export type KookAttachment = {
	type?: 'image' | 'video' | 'audio' | 'file' | string
	url?: string
	name?: string
	file_type?: string
}
export type KookEventExtra = {
	guild_id?: string
	channel_name?: string
	author?: { id?: string; username?: string; nickname?: string; bot?: boolean }
	kmarkdown?: { raw_content?: string }
	attachments?: KookAttachment | KookAttachment[]
	type?: string
	body?: unknown
}
export type KookEvent<Extra extends KookEventExtra = KookEventExtra> = {
	type: number
	target_id: string
	author_id: string
	content?: string
	msg_id: string
	msg_timestamp: number
	channel_type: 'GROUP' | 'PERSON' | string
	extra?: Extra
}
export type KookGatewayFrame = {
	s: number
	sn?: number
	d?: KookEvent | { code?: number; session_id?: string }
}

export const KOOK_TEXT = 1
export const KOOK_IMAGE = 2
export const KOOK_VIDEO = 3
export const KOOK_FILE = 4
export const KOOK_KMARKDOWN = 9
export const SIGNAL_EVENT = 0
export const SIGNAL_HELLO = 1
export const SIGNAL_PING = 2
export const SIGNAL_PONG = 3
export const SIGNAL_RECONNECT = 5

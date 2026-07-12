export type { TelegramChat, TelegramMessage, TelegramUpdate, TelegramUser } from '@gramio/types'

export type TelegramSettingsDoc = {
	id: string
	accountId: string
	hasToken: boolean
	tokenPreview: string | null
	apiBase: string
	updatedAt: number
}
export type TelegramStatusDoc = {
	id: string
	accountId: string
	phase: 'unconfigured' | 'offline' | 'connecting' | 'online' | 'error'
	botId: string | null
	username: string | null
	lastError: string | null
	updatedAt: number
}

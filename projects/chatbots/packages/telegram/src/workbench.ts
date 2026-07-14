import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { TelegramPlugin } from './plugin.ts'

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

export class TelegramWorkbenchRpc extends RpcTarget {
	constructor(private readonly plugin: TelegramPlugin) {
		super()
	}
	async upsertBot(input: { id: string; token?: string; apiBase?: string }) {
		await this.plugin.upsertBot(input)
		return { ok: true as const }
	}
	async removeBot(id: string) {
		await this.plugin.removeBot(id)
		return { ok: true as const }
	}
	async testBot(id: string): Promise<{ ok: boolean; message: string }> {
		try {
			const identity = await this.plugin.bot(id).getMe()
			return { ok: true, message: `Telegram Bot @${identity.username ?? identity.id} 鉴权成功。` }
		} catch (error) {
			return { ok: false, message: errorMessage(error) }
		}
	}
	reconnectBot(id: string) {
		return this.plugin.reconnectBot(id)
	}
	disconnectBot(id: string) {
		return this.plugin.disconnectBot(id)
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

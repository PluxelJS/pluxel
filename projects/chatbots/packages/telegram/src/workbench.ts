import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { TelegramPlugin } from './plugin.ts'
import type { TelegramWorkbenchCommands } from './workbench-contract.ts'

export class TelegramWorkbenchRpc extends RpcTarget implements TelegramWorkbenchCommands {
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

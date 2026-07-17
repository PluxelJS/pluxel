import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { Result } from './api/types.ts'
import type { KookPlugin } from './plugin.ts'
import type { KookWorkbenchCommands } from './workbench-contract.ts'

export class KookWorkbenchRpc extends RpcTarget implements KookWorkbenchCommands {
	constructor(private readonly plugin: KookPlugin) {
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
			const identity = unwrap(await this.plugin.bot(id).getUserMe())
			return { ok: true, message: `KOOK Bot ${identity.username ?? identity.id} 鉴权成功。` }
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

function unwrap<Value>(result: Result<Value>): Value {
	if (result.ok === true) return result.data
	const failure = result as Extract<Result<Value>, { ok: false }>
	throw new Error(`KOOK API error ${failure.code}: ${failure.message}`)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { Result } from './api/types.ts'
import type { KookGatewayPhase } from './gateway.ts'
import type { KookPlugin } from './plugin.ts'

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
	gatewayPhase: KookGatewayPhase
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

export class KookManagementRpc extends RpcTarget {
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

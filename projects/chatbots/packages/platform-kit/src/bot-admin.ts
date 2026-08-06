import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { BotPhase } from './bot-status.ts'

export type BotAdminPhase = Exclude<BotPhase, 'destroyed'>

export type BotAdminAccount<Diagnostics extends object> = Readonly<{
	id: string
	apiBase: string
	tokenPreview: string
	phase: BotAdminPhase
	identityId: string | null
	username: string | null
	lastError: string | null
	connectedAt: number | null
	updatedAt: number
	diagnostics: Readonly<Diagnostics>
}>

export type BotAdminSnapshot<Account extends BotAdminAccount<object>> = Readonly<{
	accounts: readonly Account[]
}>

export type BotAdminEvents<Account extends BotAdminAccount<object>> = {
	snapshot: BotAdminSnapshot<Account>
}

export interface BotAdminCommands {
	upsertBot(input: { id: string; token?: string; apiBase?: string }): Promise<{ ok: true }>
	removeBot(id: string): Promise<{ ok: true }>
	testBot(id: string): Promise<{ ok: true; message: string } | { ok: false; message: string }>
	reconnectBot(id: string): Promise<void>
	disconnectBot(id: string): Promise<void>
}

export type BotAdminOperations = {
	upsert(input: { id: string; token?: string; apiBase?: string }): Promise<unknown>
	remove(id: string): Promise<unknown>
	reconnect(id: string): Promise<unknown>
	disconnect(id: string): Promise<unknown>
	test(id: string): Promise<string>
}

/** Shared Workbench command transport; platform ownership stays in the supplied operations. */
export class BotAdminRpc extends RpcTarget implements BotAdminCommands {
	constructor(private readonly operations: BotAdminOperations) {
		super()
	}

	async upsertBot(input: { id: string; token?: string; apiBase?: string }) {
		await this.operations.upsert(input)
		return { ok: true as const }
	}

	async removeBot(id: string) {
		await this.operations.remove(id)
		return { ok: true as const }
	}

	async testBot(
		id: string,
	): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
		try {
			return { ok: true, message: await this.operations.test(id) }
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) }
		}
	}

	async reconnectBot(id: string): Promise<void> {
		await this.operations.reconnect(id)
	}

	async disconnectBot(id: string): Promise<void> {
		await this.operations.disconnect(id)
	}
}

/** Binds a manager-owned snapshot source to one Workbench event stream. */
export function attachBotAdminState<Account extends BotAdminAccount<object>>(
	accounts: () => readonly Account[],
	subscribe: (listener: () => void) => () => void,
	events: {
		emit(event: 'snapshot', payload: BotAdminSnapshot<Account>): void
		signal: AbortSignal
	},
): () => void {
	const publish = () => events.emit('snapshot', { accounts: accounts() })
	const unsubscribe = subscribe(publish)
	let active = true
	const cleanup = () => {
		if (!active) return
		active = false
		unsubscribe()
		events.signal.removeEventListener('abort', cleanup)
	}
	events.signal.addEventListener('abort', cleanup, { once: true })
	publish()
	return cleanup
}

export function maskBotSecret(value: string): string {
	return value.length <= 8 ? '••••••••' : `${value.slice(0, 4)}••••${value.slice(-4)}`
}

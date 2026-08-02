import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { DiscordBotManager } from '../bot/manager.ts'
import type { DiscordAdminCommands, DiscordAdminEvents } from './contract.ts'

export class DiscordWorkbenchRpc extends RpcTarget implements DiscordAdminCommands {
	constructor(private readonly discord: DiscordBotManager) {
		super()
	}

	async upsertBot(input: { id: string; token?: string }): Promise<void> {
		await this.discord.upsert(input)
	}

	removeBot(id: string): Promise<void> {
		return this.discord.remove(id)
	}

	async reconnectBot(id: string): Promise<void> {
		await this.discord.reconnect(id)
	}

	async disconnectBot(id: string): Promise<void> {
		await this.discord.disconnect(id)
	}
}

export function attachDiscordAdminState(
	discord: DiscordBotManager,
	events: {
		emit(event: 'snapshot', payload: DiscordAdminEvents['snapshot']): void
		signal: AbortSignal
	},
): () => void {
	const publish = () => events.emit('snapshot', { accounts: discord.adminAccounts() })
	const unsubscribe = discord.observe(publish)
	const cleanup = () => {
		unsubscribe()
		events.signal.removeEventListener('abort', cleanup)
	}
	events.signal.addEventListener('abort', cleanup, { once: true })
	publish()
	return cleanup
}

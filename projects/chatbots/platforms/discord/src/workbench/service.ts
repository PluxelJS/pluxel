import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { DiscordPlugin } from '../plugin.ts'
import type { DiscordAdminCommands, DiscordAdminEvents } from './contract.ts'

export class DiscordWorkbenchRpc extends RpcTarget implements DiscordAdminCommands {
	constructor(private readonly discord: DiscordPlugin) {
		super()
	}

	async upsertBot(input: { id: string; token?: string }): Promise<void> {
		await this.discord.upsertBot(input)
	}

	removeBot(id: string): Promise<void> {
		return this.discord.removeBot(id)
	}

	async reconnectBot(id: string): Promise<void> {
		await this.discord.reconnectBot(id)
	}

	async disconnectBot(id: string): Promise<void> {
		await this.discord.disconnectBot(id)
	}
}

export function attachDiscordAdminState(
	discord: DiscordPlugin,
	events: {
		emit(event: 'snapshot', payload: DiscordAdminEvents['snapshot']): void
		signal: AbortSignal
	},
): () => void {
	const publish = () => events.emit('snapshot', { accounts: discord.adminAccounts() })
	const unsubscribe = discord.observeAdmin(publish)
	const cleanup = () => {
		unsubscribe()
		events.signal.removeEventListener('abort', cleanup)
	}
	events.signal.addEventListener('abort', cleanup, { once: true })
	publish()
	return cleanup
}

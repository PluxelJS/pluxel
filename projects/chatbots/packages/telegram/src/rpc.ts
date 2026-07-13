import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { TelegramPlugin } from './plugin.ts'

export class TelegramAdapterRpc extends RpcTarget {
	constructor(private readonly plugin: TelegramPlugin) {
		super()
	}
	upsertBot(input: { id: string; token?: string; apiBase?: string }) {
		return this.plugin.upsertBot(input)
	}
	removeBot(id: string) {
		return this.plugin.removeBot(id)
	}
	testBot(id: string) {
		return this.plugin.testBot(id)
	}
	reconnectBot(id: string) {
		return this.plugin.reconnectBot(id)
	}
	disconnectBot(id: string) {
		return this.plugin.disconnectBot(id)
	}
}

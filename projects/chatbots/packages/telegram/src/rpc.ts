import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { TelegramAdapterPlugin } from './plugin.ts'

export class TelegramAdapterRpc extends RpcTarget {
	constructor(private readonly plugin: TelegramAdapterPlugin) {
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
	saveSettings(input: { token?: string; apiBase?: string }) {
		return this.plugin.saveSettings(input)
	}
	clearToken() {
		return this.plugin.clearToken()
	}
	testConnection() {
		return this.plugin.testConnection()
	}
	reconnect() {
		return this.plugin.reconnect()
	}
	disconnect() {
		return this.plugin.disconnect()
	}
}

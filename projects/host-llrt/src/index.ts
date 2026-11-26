import { BasePlugin, Plugin } from '@pluxel/core'

export abstract class TicketPrinter {
	abstract issue(name: string): string
}

@Plugin()
export class TicketDesk extends BasePlugin {
	print() {
		return this.ctx.service(TicketPrinter).issue('desk')
	}

	async checkReceiptStorage(ticket: string) {
		const kv = this.ctx.vault.kv()
		const written = await kv.set('test-receipt', ticket)
		const saved = await kv.get<string>('test-receipt')
		if (!saved.exists || !saved.writable || saved.source !== 'kv' || saved.value !== ticket)
			throw new Error('The encrypted Vault did not return the saved ticket')
		await kv.delete('test-receipt', { expectedRevision: written.revision })
		const removed = await kv.get('test-receipt')
		if (removed.exists) throw new Error('The encrypted Vault still contains the deleted ticket')
		return { read: saved.value, deleted: true }
	}
}

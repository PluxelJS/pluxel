import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin()
export class ExtraProvider extends BasePlugin {}

@Plugin()
export class RequestProvider extends BasePlugin {
	private readonly generation = crypto.randomUUID()

	protected override async init() {
		await this.ctx.tinybase.open()
	}

	async deploymentProbe() {
		const { value, source, writable } = await this.ctx.vault.kv().get<string>('probe')
		return { value, source, writable, generation: this.generation }
	}

	async load(id: string, signal: AbortSignal) {
		const response = await this.ctx.fetch(`https://backend.test/${encodeURIComponent(id)}`, {
			signal,
		})
		const value = await response.text()
		const store = await this.ctx.tinybase.open()
		const ordinal = Number(store.getValue('ordinal') ?? 0) + 1
		store.setValue('ordinal', ordinal)
		await this.ctx.tinybase.flush()
		return { value, ordinal, generation: this.generation }
	}
}

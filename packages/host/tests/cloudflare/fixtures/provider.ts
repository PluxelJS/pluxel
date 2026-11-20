import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin()
export class RequestProvider extends BasePlugin {
	private readonly lifetime: string[] = []

	protected override async init() {
		await this.ctx.tinybase.open()
		this.lifetime.push('provider started')
		return () => {
			this.lifetime.push('provider closed')
		}
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
		return { value, ordinal, providerLifetime: this.lifetime }
	}
}

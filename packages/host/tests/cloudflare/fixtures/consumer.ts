import { BasePlugin, Plugin } from '@pluxel/core'
import { RequestProvider } from './provider'

@Plugin()
export class RequestConsumer extends BasePlugin {
	private readonly lifetime: string[] = []

	constructor(private readonly provider: RequestProvider) {
		super()
	}

	protected override init() {
		this.lifetime.push('consumer started')
		return () => {
			this.lifetime.push('consumer closed')
		}
	}

	async load(id: string, signal: AbortSignal) {
		const reply = await this.provider.load(id, signal)
		return { ...reply, consumerLifetime: this.lifetime }
	}

	async checkCancelledFetch(id: string) {
		const reason = new DOMException('Fixture cancelled before sending', 'AbortError')
		try {
			await this.provider.load(id, AbortSignal.abort(reason))
		} catch (error) {
			if (error === reason) return { cancelled: true }
			throw error
		}
		throw new Error('Cancelled fetch was admitted')
	}
}

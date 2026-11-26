import { BasePlugin, Plugin } from '@pluxel/core'
import { RequestProvider } from './provider'

@Plugin()
export class RequestConsumer extends BasePlugin {
	constructor(private readonly provider: RequestProvider) {
		super()
	}

	load(id: string, signal: AbortSignal) {
		return this.provider.load(id, signal)
	}

	async echo(request: Request, binding: { fetch(request: Request): Promise<Response> }) {
		const response = await binding.fetch(request)
		return response.text()
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

import { BasePlugin, Plugin } from '@pluxel/core'
import { Provider } from './Provider'

@Plugin()
export class Consumer extends BasePlugin {
	constructor(private readonly provider: Provider) {
		super()
	}

	greet(signal?: AbortSignal) {
		return this.provider.greet(signal)
	}
}

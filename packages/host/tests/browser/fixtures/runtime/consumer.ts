import { BasePlugin, Plugin } from '@pluxel/core'
import { Provider } from './provider'
import { trace } from './trace'
@Plugin()
export class Consumer extends BasePlugin {
	constructor(private provider: Provider) {
		super()
	}
	protected override init() {
		this.ctx.logger.info('consumer started')
		trace.push(this.provider.greet())
		return () => {
			this.ctx.logger.info('consumer closed')
			trace.push('consumer closed')
		}
	}
}

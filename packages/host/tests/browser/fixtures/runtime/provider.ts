import { BasePlugin, Plugin } from '@pluxel/core'
import { trace } from './trace'
@Plugin()
export class Provider extends BasePlugin {
	protected override async init() {
		const fs = await this.ctx.fs()
		await fs.writeFile('browser.txt', 'browser storage')
		this.ctx.logger.info('provider started', { storage: await fs.readFile('browser.txt', 'utf8') })
		trace.push('provider started')
		return () => {
			this.ctx.logger.info('provider closed')
			trace.push('provider closed')
		}
	}
	greet() {
		return 'hello from dependency'
	}
}

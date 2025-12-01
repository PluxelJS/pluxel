import { BasePlugin, Config, Plugin } from '@pluxel/core'
import { f, v } from '@pluxel/hmr/config'

export const config = v.object({
	name: v.optional(
		v.pipe(
			v.string(),
			v.hexColor(),
			v.check((input) => {
				return false
			}, '测试不通过'),
		),
		'#000000',
	),
})

@Plugin({ name: 'PluginB', type: 'hook' })
export class PluginB extends BasePlugin {
	@Config(config)
	private a: Config<typeof config>
	init(): void {
		this.ctx.logger.info('PluginB initialized')
		throw new Error('d')
	}

	doSomething(): void {
		// this.ctx.logger.info(this.ctx.caller, 'call from')
		this.ctx.logger.info('PluginB doing something...')
	}
}

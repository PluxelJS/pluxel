import { BasePlugin, Plugin } from '@pluxel/runtime'
import { TelegramConfig } from './config'
import { PluginB } from './PluginB'
import { PluginC } from './PluginC'
import { test1 } from './testconfig'

@Plugin({ name: 'PluginA', type: 'event' })
export class PluginA extends BasePlugin {
	private test1 = this.configs.use(test1)
	private telegram = this.configs.use(TelegramConfig)

	constructor(public pluginB: PluginB) {
		super()
	}

	override init(_abort: AbortSignal): void | Promise<void> {
		void this.test1
		void this.telegram

		this.pluginB.doSomething()
		const pluginC = this.ctx.registry.getInstance(PluginC)
		this.ctx.logger.info('PluginA optional dep', { pluginC: Boolean(pluginC) })

		this.ctx.http.plugin.routes(
			(app) =>
				app.get('/', ({ set }) => {
					set.headers['content-type'] = 'text/html; charset=utf-8'
					return 'text'
				}),
			{ path: '/a', id: 'PluginA:page' },
		)
	}
	doSomething(): void {
		this.ctx.logger.info('PluginA doing somethinga...')
	}
}

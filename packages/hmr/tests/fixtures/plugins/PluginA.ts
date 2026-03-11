import { BasePlugin, Plugin } from '@pluxel/hmr'
import { TelegramConfig } from './config'
import type { PluginB } from './PluginB'
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

		const app = this.ctx.http.hono.app()
		app.get('/', (c) => c.html('text'))
		this.ctx.http.mountBoundary({
			id: 'PluginA:page',
			base: '/a',
			boundary: app,
		})
	}
	doSomething(): void {
		this.ctx.logger.info('PluginA doing somethinga...')
	}
}

import { BasePlugin, Plugin, v } from '@pluxel/runtime'
import { TelegramConfig } from './config'
import { PluginB } from './PluginB'
import { PluginC } from './PluginC'
import { test1 } from './testconfig'

const PluginAConfig = v.object({
	test: test1,
	telegram: TelegramConfig,
})

@Plugin({ displayName: 'Plugin A' })
export class PluginA extends BasePlugin {
	private config = this.configs.use(PluginAConfig)

	constructor(public pluginB: PluginB) {
		super()
	}

	override init(_abort: AbortSignal): void | Promise<void> {
		void this.config

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

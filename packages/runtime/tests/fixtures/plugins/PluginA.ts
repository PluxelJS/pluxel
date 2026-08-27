import { BasePlugin, definePluginRef, Plugin, v } from '@pluxel/runtime'
import { TelegramConfig } from './config'
import { PluginB } from './PluginB'
import type { PluginC } from './PluginC'
import { test1 } from './testconfig'

const PluginCRef = definePluginRef<PluginC>()

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
		this.plugins.use(PluginCRef, () => {
			this.ctx.logger.info('PluginA optional dep', { pluginC: true })
		})

		this.ctx.elysia.get('/a', ({ set }) => {
			set.headers['content-type'] = 'text/html; charset=utf-8'
			return 'text'
		})
	}
	doSomething(): void {
		this.ctx.logger.info('PluginA doing somethinga...')
	}
}

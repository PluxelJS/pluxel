import { BasePlugin, Plugin } from '@pluxel/hmr'
import { Config } from './config'
// PluginA.ts
// PluginA 依赖 PluginB 为必选依赖，依赖 PluginC 为可选依赖
// biome-ignore lint/style/useImportType: <PluginSystem>
import { PluginB } from './PluginB'
// biome-ignore lint/style/useImportType: <explanation>
import { PluginC } from './PluginC'
import { test1 } from './testconfig'

@Plugin({ name: 'PluginA', type: 'event' })
export class PluginA extends BasePlugin {
	private pluginC?: PluginC

	@Config(test1)
	private test1!: Config<typeof test1>

	constructor(public pluginB: PluginB) {
		super()
	}

	init(_abortt: AbortSignal): void | Promise<void> {
		this.pluginB.doSomething()
		// 可选依赖 PluginC 进行判断_pluginC
		if (this.pluginC) {
			this.ctx.logger.info('PluginA using PluginC dependency')
		} else {
			this.ctx.logger.info('PluginA: PluginC dependency not injected')
		}

		this.test1
		// this.ctx.honoService.mountStatic('/bbb', { root: 'public/assets', index: 'test.txt' })
		this.ctx.honoService.modifyApp((app) => {
			app.get('/a', (c) => {
				return c.html('text')
			})
		})
	}
	doSomething(): void {
		this.ctx.logger.info('PluginA doing somethinga...')
	}
}

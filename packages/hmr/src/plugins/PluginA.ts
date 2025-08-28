import { BasePlugin, Optional, Plugin } from '@pluxel/core'
import { Config } from './config'
// PluginA.ts
// PluginA 依赖 PluginB 为必选依赖，依赖 PluginC 为可选依赖
// biome-ignore lint/style/useImportType: <PluginSystem>
import { PluginB } from './PluginB'
// biome-ignore lint/style/useImportType: <explanation>
import { PluginC } from './PluginC'
import { test, test2 } from './testconfig'

@Plugin({ name: 'PluginA', type: 'event' })
export class PluginA extends BasePlugin {
	@Config(test)
	private config!: Config<typeof test>;

	@Config(test2)
	private config2!: Config<typeof test2>;

	constructor(public pluginB: PluginB, @Optional() public pluginC?: PluginC) {
    super();
  }


  init(): void {
		this.ctx.logger.info('PluginA initialized')
		// 使用必需依赖 PluginB
		this.pluginB.doSomething()
		// 可选依赖 PluginC 进行判断
		if (this.pluginC) {
			this.ctx.logger.info('PluginA using PluginC dependency')
		} else {
			this.ctx.logger.info('PluginA: PluginC dependency not injected')
		}
		this.ctx.test.collect()
		this.ctx.honoService.modifyApp((app) => {
			app.get('/a', (c) => {
				return c.html('text')
			})
		})
	}

	doSomething(): void {
		this.ctx.logger.info('PluginA doing something...')
	}
}

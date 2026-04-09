import { BasePlugin, Plugin } from '@pluxel/test'
// PluginA.ts
// PluginA 依赖 PluginB 为必选依赖；PluginC/PluginD 只是运行期附加能力
import { PluginB } from './PluginB'
import { PluginC, PluginD } from './PluginC'

@Plugin()
export class PluginA extends BasePlugin {
	constructor(public pluginB: PluginB) {
		super()
	}

	init(): void {
		// Optional dependency pattern (plan A): resolve if running; otherwise ignore.
		this.ctx.registry.getInstance(PluginC)?.doExampleLog()
		this.ctx.registry.getInstance(PluginD)?.doSomethingElse()

		this.ctx.logger.info('PluginA initialized')
		// 使用必需依赖 PluginB
		this.pluginB.doSomething()
	}

	doSomething(): void {
		this.ctx.logger.info('PluginA doing something...')
	}
}

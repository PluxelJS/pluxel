import { BasePlugin, Plugin, definePluginRef } from '@pluxel/core/test'
// PluginA.ts
// PluginA 依赖 PluginB 为必选依赖；PluginC/PluginD 只是运行期附加能力
import { PluginB } from './PluginB'
import { PluginC, PluginD } from './PluginC'

const PluginCRef = definePluginRef<PluginC>()
const PluginDRef = definePluginRef<PluginD>()

@Plugin()
export class PluginA extends BasePlugin {
	constructor(public pluginB: PluginB) {
		super()
	}

	init(): void {
		this.plugins.use(PluginCRef, (plugin) => plugin.doExampleLog())
		this.plugins.use(PluginDRef, (plugin) => plugin.doSomethingElse())

		this.ctx.logger.info('PluginA initialized')
		// 使用必需依赖 PluginB
		this.pluginB.doSomething()
	}

	doSomething(): void {
		this.ctx.logger.info('PluginA doing something...')
	}
}

import { BasePlugin, Plugin } from '../context'
// PluginA.ts
// PluginA 依赖 PluginB 为必选依赖，依赖 PluginC 为可选依赖
// biome-ignore lint/style/useImportType: <PluginSystem>
import { PluginB } from './PluginB'
// biome-ignore lint/style/useImportType: <explanation>
import { PluginC } from './PluginC'

@Plugin()
export class PluginA extends BasePlugin {
	constructor(public pluginB: PluginB) {
		super()
	}

	private pluginC?: PluginC

	init(): void {
		this.ctx.registry.optional(
			() => import('./PluginC').then((m) => [m.PluginC, m.PluginD] as const),
			([c, d]) => {
				c?.doExampleLog()
				d?.doSomethingElse()
			},
			{ multi: true },
		)

		this.ctx.logger.info('PluginA initialized')
		// 使用必需依赖 PluginB
		this.pluginB.doSomething()

		console.log(`当前情境 ${this.ctx.name}`)
	}

	doSomething(): void {
		this.ctx.logger.info('PluginA doing something...')
	}
}

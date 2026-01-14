import { BasePlugin, Plugin } from '@pluxel/core/test'
// PluginA.ts
// PluginA 依赖 PluginB 为必选依赖，依赖 PluginC 为可选依赖
// biome-ignore lint/style/useImportType: keep a runtime import so decorator metadata can reference PluginB
import { PluginB } from './PluginB'

@Plugin()
export class PluginA extends BasePlugin {
	constructor(public pluginB: PluginB) {
		super()
	}

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
	}

	doSomething(): void {
		this.ctx.logger.info('PluginA doing something...')
	}
}

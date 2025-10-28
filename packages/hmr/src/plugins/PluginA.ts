import { BasePlugin, Plugin } from '@pluxel/hmr'
import { v } from './config'
// PluginA.ts
// PluginA 依赖 PluginB 为必选依赖，依赖 PluginC 为可选依赖
// biome-ignore lint/style/useImportType: <PluginSystem>
import { PluginB } from './PluginB'
// biome-ignore lint/style/useImportType: <explanation>
import { PluginC } from './PluginC'

export const a = v.object({ name: v.array(v.picklist(['a', 'b'])) })
@Plugin({ name: 'PluginA', type: 'event' })
export class PluginA extends BasePlugin {
	private pluginC?: PluginC

	constructor(public pluginB: PluginB) {
		super()
	}

	init(_abortt: AbortSignal): void | Promise<void> {
		this.pluginC =
			(this.ctx.registry.pluginRegistry.lastContainer.getMaybe(PluginC) as PluginC | undefined) ??
			undefined

		this.pluginB.doSomething()
		// 可选依赖 PluginC 进行判断_pluginC
		if (this.pluginC) {
			this.ctx.logger.info('PluginA using PluginC dependency')
		} else {
			this.ctx.logger.info('PluginA: PluginC dependency not injected')
		}

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

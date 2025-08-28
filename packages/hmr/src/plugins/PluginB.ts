import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'
// PluginB.ts
import { PluginC } from './PluginC'
export const a = v.object({ name: v.string() })
@Plugin({ name: 'PluginB', type: 'hook' })
export class PluginB extends BasePlugin {
	init(): void {
		this.ctx.logger.info('PluginBaa initialized', a.type)
		this.ctx.honoService.modifyApp((app) => {
			this.ctx.logger.info('添加了路由，爱来自 plugin')
			app.get('/api/b', (c) => {
				return c.html('text')
			})
		})
	}

	doSomething(): void {
		// this.ctx.logger.info(this.ctx.caller, 'call from')
		this.ctx.logger.info('PluginaB doing something...')
	}
}

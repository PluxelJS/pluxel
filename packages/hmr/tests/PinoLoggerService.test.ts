import { describe, expect, it } from 'bun:test'
import { Context } from '@pluxel/core'
import { PinoLoggerService } from '../src/services/logger/PinoLoggerService'

function createPluginContext(root: Context, name: string, id: string): Context {
	const ctx = root.extend({ name }) as Context
	;(ctx as any).pluginInfo = { id }
	return ctx
}

describe('PinoLoggerService', () => {
	it('binds pluginId and ctx.name into name', () => {
		const root = new Context({ name: 'root' }) as Context
		const pluginCtx = createPluginContext(root, 'pluginA', 'plugin-a')
		const service = new PinoLoggerService(pluginCtx, { level: 'info' })
		const bindings = service.logger.bindings() as Record<string, unknown>
		expect(bindings.name).toBe('plugin-a(pluginA)')
		expect(bindings.pluginId).toBe('plugin-a')
		expect(bindings.context).toBe('pluginA')
	})

	it('keeps name minimal when ctx.name matches pluginId', () => {
		const root = new Context({ name: 'root' }) as Context
		const pluginCtx = createPluginContext(root, 'plugin-a', 'plugin-a')
		const service = new PinoLoggerService(pluginCtx, { level: 'info' })
		const bindings = service.logger.bindings() as Record<string, unknown>
		expect(bindings.name).toBe('plugin-a')
	})

	it('throws when a different context rebinds the service', () => {
		const root = new Context({ name: 'root' }) as Context
		const service = new PinoLoggerService(root, { level: 'info' })
		const pluginCtx = createPluginContext(root, 'pluginA', 'plugin-a')
		expect(() => {
			service.ctx = pluginCtx
		}).toThrow('PinoLoggerService')
	})
})

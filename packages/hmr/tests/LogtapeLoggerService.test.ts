import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { configureSync, type LogRecord, resetSync } from '@logtape/logtape'
import { Context } from '@pluxel/hmr'
import { LogtapeLoggerService } from '../src/logger/LogtapeLoggerService'

function createPluginContext(root: Context, name: string, id: string): Context {
	const ctx = root.extend({ name }) as Context
	;(ctx as any).pluginInfo = { id }
	return ctx
}

describe('LogtapeLoggerService', () => {
	let records: LogRecord[] = []

	beforeEach(() => {
		records = []
		configureSync({
			sinks: {
				capture(record) {
					records.push(record)
				},
			},
			loggers: [
				{ category: ['pluxel', 'hmr'], lowestLevel: 'trace', sinks: ['capture'] },
				{ category: ['pluxel', 'plugins'], lowestLevel: 'trace', sinks: ['capture'] },
				{ category: ['logtape', 'meta'], lowestLevel: 'fatal', sinks: ['capture'] },
			],
		})
	})

	afterEach(() => resetSync())

	it('attaches pluginId/context/name into record properties', () => {
		const root = new Context({ name: 'root' }) as Context
		const pluginCtx = createPluginContext(root, 'pluginA', 'plugin-a')
		const service = new LogtapeLoggerService(pluginCtx)
		service.info('hello')

		const rec = records.find((r) => r.category.join(':') === 'pluxel:plugins')
		expect(rec).toBeTruthy()
		expect(rec?.properties.pluginId).toBe('plugin-a')
		expect(rec?.properties.context).toBe('pluginA')
		expect(rec?.properties.name).toBe('plugin-a(pluginA)')
	})

	it('uses "hmr" category for non-plugin contexts', () => {
		const root = new Context({ name: 'root' }) as Context
		const service = new LogtapeLoggerService(root)
		service.warn('warn')

		const rec = records.find((r) => r.category.join(':') === 'pluxel:hmr')
		expect(rec).toBeTruthy()
		expect(rec?.properties.name).toBe('root')
	})
})

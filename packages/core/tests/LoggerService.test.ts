import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureSync, type LogRecord, resetSync } from '@logtape/logtape'
import { withCoreContext } from '@pluxel/core/test'

describe('LoggerService', () => {
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
				{ category: ['pluxel', 'core'], lowestLevel: 'trace', sinks: ['capture'] },
				{ category: ['pluxel', 'plugins'], lowestLevel: 'trace', sinks: ['capture'] },
				// Silence LogTape's internal meta logger during tests.
				{ category: ['logtape', 'meta'], lowestLevel: 'fatal', sinks: ['capture'] },
			],
		})
	})

	afterEach(() => {
		resetSync()
	})

	it('logs as category "core" when plugin info is missing', () => {
		return withCoreContext(
			(ctx) => {
				ctx.logger.info('hello', { id: 1 })

				const rec = records.find((r) => r.category.join(':') === 'pluxel:core')
				expect(rec).toBeTruthy()
				expect(rec?.category).toEqual(['pluxel', 'core'])
				expect(rec?.properties.context).toBe('core-test')
				expect(rec?.properties.id).toBe(1)
			},
			{ name: 'core-test' },
		)
	})

	it('logs as category "plugins" and attaches pluginId when available', () => {
		return withCoreContext(
			(ctx) => {
				ctx.pluginInfo = { id: 'PluginX' } as any

				ctx.logger.warn('warn message')

				const rec = records.find((r) => r.category.join(':') === 'pluxel:plugins')
				expect(rec).toBeTruthy()
				expect(rec?.category).toEqual(['pluxel', 'plugins'])
				expect(rec?.properties.context).toBe('plugin-test')
				expect(rec?.properties.pluginId).toBe('PluginX')
			},
			{ name: 'plugin-test' },
		)
	})
})

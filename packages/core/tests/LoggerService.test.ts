import { configureSync, type LogRecord, resetSync } from '@logtape/logtape'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LoggerService } from '../src/services/LoggerService'
import { withCoreContext } from '../src/test'

describe('LoggerService', () => {
	let records: LogRecord[] = []

	beforeEach(() => {
		records = []
		configureSync({
			sinks: { capture: (record) => records.push(record) },
			loggers: [
				{ category: ['pluxel'], lowestLevel: 'trace', sinks: ['capture'] },
				{ category: ['logtape', 'meta'], lowestLevel: 'fatal', sinks: [] },
			],
		})
	})

	afterEach(() => resetSync())

	it('binds runtime identity to the configured root', () =>
		withCoreContext(
			(ctx) => {
				ctx.logger.info('hello', { id: 1 })
				const record = records.find((item) => item.rawMessage === 'hello')
				expect(record?.category).toEqual(['pluxel', 'runtime', 'root-test'])
				expect(record?.properties).toMatchObject({ context: 'core-test', id: 1 })
			},
			{ name: 'core-test', logger: { rootId: 'root-test' } },
		))

	it('encodes plugin identity in the category instead of record properties', () =>
		withCoreContext(
			(ctx) => {
				ctx.pluginInfo = { id: 'PluginX' } as never
				ctx.logger.warn('warn message')
				const record = records.find((item) => item.rawMessage === 'warn message')
				expect(record?.category).toEqual(['pluxel', 'plugins', 'root-test', 'PluginX'])
				expect(record?.properties.context).toBe('plugin-test')
				expect(record?.properties.pluginId).toBeUndefined()
			},
			{ name: 'plugin-test', logger: { rootId: 'root-test' } },
		))

	it('encodes debug topic segments and preserves plugin ownership', () =>
		withCoreContext(
			(ctx) => {
				ctx.pluginInfo = { id: 'PluginX' } as never
				ctx.logger.getDebugChannel('hmr:cache').debug('cache probe')
				const record = records.find((item) => item.rawMessage === 'cache probe')
				expect(record?.category).toEqual([
					'pluxel',
					'debug',
					'root-test',
					'plugin',
					'PluginX',
					'hmr',
					'cache',
				])
			},
			{ name: 'plugin-test', logger: { rootId: 'root-test' } },
		))

	it('does not capture caller information at the author facade', () => {
		const logger = new LoggerService({ name: 'caller-test' } as never, { rootId: 'root-test' })
		logger.info('caller probe')
		const record = records.find((item) => item.rawMessage === 'caller probe')
		expect(record?.properties.caller).toBeUndefined()
	})
})

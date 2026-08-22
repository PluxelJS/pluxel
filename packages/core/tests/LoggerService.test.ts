import { configureSync, type LogRecord, resetSync } from '@logtape/logtape'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LoggerService } from '../src/logger/LoggerService'
import { readPluginLogIdentity } from '../src/logger/categories'
import { withCoreContext } from '../src/test'
import { parsePluginNodeAddress } from '../src/plugins'

const loggerPluginAddress = parsePluginNodeAddress({
	definition: {
		entry: { kind: 'package-root', packageName: '@test/logger-plugin' },
		exportName: 'PluginX',
	},
	variant: 'default',
})

function installLoggerTestPluginInfo(ctx: object): void {
	Object.defineProperty(ctx, 'pluginInfo', {
		value: Object.freeze({ nodeAddress: loggerPluginAddress }),
		writable: false,
		configurable: false,
	})
}

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
				installLoggerTestPluginInfo(ctx)
				ctx.logger.warn('warn message')
				const record = records.find((item) => item.rawMessage === 'warn message')
				expect(record?.category).toEqual([
					'pluxel',
					'plugins',
					'root-test',
					'v1',
					'package',
					'PluginX',
					'@test',
					'logger-plugin',
				])
				expect(record?.properties.context).toBe('plugin-test')
				expect(record?.properties.pluginId).toBeUndefined()
			},
			{ name: 'plugin-test', logger: { rootId: 'root-test' } },
		))

	it('reuses the validated identity projection for one immutable category', () => {
		const logger = new LoggerService(
			{
				name: 'plugin-test',
				pluginInfo: { nodeAddress: loggerPluginAddress },
			} as never,
			{ rootId: 'root-test' },
		)
		logger.info('first')
		logger.info('second')

		const first = records.find((item) => item.rawMessage === 'first')!
		const second = records.find((item) => item.rawMessage === 'second')!
		expect(second.category).toBe(first.category)
		expect(readPluginLogIdentity(second.category)).toBe(readPluginLogIdentity(first.category))
	})

	it('encodes debug topic segments and preserves plugin ownership', () =>
		withCoreContext(
			(ctx) => {
				installLoggerTestPluginInfo(ctx)
				ctx.logger.getDebugChannel('hmr:cache').debug('cache probe')
				const record = records.find((item) => item.rawMessage === 'cache probe')
				expect(record?.category).toEqual([
					'pluxel',
					'debug',
					'root-test',
					'plugin',
					'v1',
					'package',
					'PluginX',
					'@test',
					'logger-plugin',
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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureSync, type LogRecord, resetSync } from '@logtape/logtape'
import { withRuntimeContext } from '@pluxel/runtime/test'
import { LogtapeLoggerService } from '../src/logger/LogtapeLoggerService'
import { createLoggerPluginContext } from './support/logger-context'

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
				{ category: ['pluxel', 'core'], lowestLevel: 'trace', sinks: ['capture'] },
				{ category: ['pluxel', 'plugins'], lowestLevel: 'trace', sinks: ['capture'] },
				{ category: ['logtape', 'meta'], lowestLevel: 'fatal', sinks: ['capture'] },
			],
		})
	})

	afterEach(() => resetSync())

	it('attaches pluginId/context/name into record properties', () => {
		return withRuntimeContext((root) => {
			const pluginCtx = createLoggerPluginContext(root, 'pluginA', 'plugin-a')
			const service = new LogtapeLoggerService(pluginCtx)
			service.info('hello')

			const rec = records.find((r) => r.category.join(':') === 'pluxel:plugins')
			expect(rec).toBeTruthy()
			expect(rec?.properties.pluginId).toBe('plugin-a')
			expect(rec?.properties.context).toBe('pluginA')
			expect(rec?.properties.name).toBeUndefined()
		})
	})

	it('uses "core" category for non-plugin contexts by default', () => {
		return withRuntimeContext((root) => {
			const service = new LogtapeLoggerService(root)
			service.warn('warn')

			const rec = records.find((r) => r.category.join(':') === 'pluxel:core')
			expect(rec).toBeTruthy()
			expect(rec?.properties.context).toBe('test')
			expect(rec?.properties.name).toBeUndefined()
		})
	})
})

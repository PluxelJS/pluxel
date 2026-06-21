import { resetSync } from '@logtape/logtape'
import { ensurePluxelLogging, runtimeLogStores } from '@pluxel/runtime/logger'
import { afterEach, describe, expect, it } from 'vitest'
import { LogtapeLoggerService } from '../../src/logger/LogtapeLoggerService'

function emitPluginLogForCallerTest(pluginId = 'plugin-a') {
	const logger = new LogtapeLoggerService({ name: 'PluginA', pluginInfo: { id: pluginId } } as any)
	logger.info('hello from plugin')
}

describe('ensurePluxelLogging', () => {
	afterEach(() => resetSync())

	it('enables caller capture for the default UI log sink', async () => {
		const streamId = 'ensure-caller-default'
		await ensurePluxelLogging({
			console: false,
			file: false,
			ui: { streamId, bufferSize: 1, flushIntervalMs: 0, windowLines: 10 },
		})

		emitPluginLogForCallerTest()

		const [line] = runtimeLogStores.getOrCreate(streamId).tailWindow(1)
		expect(line?.props?.caller).toEqual(expect.stringContaining('ensure.test.ts'))
	})

	it('keeps caller capture opt-out for custom UI log sink options', async () => {
		const streamId = 'ensure-caller-opt-out'
		await ensurePluxelLogging({
			console: false,
			file: false,
			ui: {
				streamId,
				bufferSize: 1,
				flushIntervalMs: 0,
				windowLines: 10,
				caller: false,
			},
		})

		emitPluginLogForCallerTest()

		const [line] = runtimeLogStores.getOrCreate(streamId).tailWindow(1)
		expect(line?.props?.caller).toBeUndefined()
	})
})

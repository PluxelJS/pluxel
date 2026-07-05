import { resetSync } from '@logtape/logtape'
import { LoggerService } from '@pluxel/core/services'
import { ensurePluxelLogging, runtimeLogStores } from '@pluxel/runtime/logger'
import { withRuntimeContext } from '@pluxel/runtime/test'
import { afterEach, describe, expect, it } from 'vitest'
import { createLoggerPluginContext } from '../support/logger-context'

async function emitPluginLogForCallerTest(pluginId = 'plugin-a') {
	return withRuntimeContext((root) => {
		const logger = new LoggerService(createLoggerPluginContext(root, 'PluginA', pluginId))
		logger.info('hello from plugin')
	})
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

		await emitPluginLogForCallerTest()

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

		await emitPluginLogForCallerTest()

		const [line] = runtimeLogStores.getOrCreate(streamId).tailWindow(1)
		expect(line?.props?.caller).toBeUndefined()
	})
})

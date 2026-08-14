import { type LogRecord } from '@logtape/logtape'
import { RuntimePluginLogPolicy } from '@pluxel/runtime/logger'
import { bench, describe } from 'vitest'
import { createRuntimeLogSink } from '../src/logger/sink'
import { RuntimeLogStoreRegistry } from '../src/logger/store'

function record(input: Partial<LogRecord> = {}): LogRecord {
	return {
		category: ['pluxel', 'plugins', 'bench-root', 'plugin-42'],
		level: 'debug',
		message: ['plugin message ', 42, { nested: { ok: true } }],
		properties: {
			pluginId: 'plugin-42',
			context: 'Plugin42',
			taskId: 'task-1',
			value: 42,
			...input.properties,
		},
		timestamp: Date.now(),
		...input,
	}
}

describe('runtime logger micro-bench', () => {
	const policy = new RuntimePluginLogPolicy({
		version: 1,
		defaultLevel: 'info',
		overrides: {
			'plugin-42': 'debug',
			'plugin-off': 'off',
		},
	})
	bench('plugin policy allows override hit', () => {
		policy.allows('plugin-42', 'debug')
	})

	const largePolicy = new RuntimePluginLogPolicy({
		version: 1,
		defaultLevel: 'info',
		overrides: Object.fromEntries(
			Array.from({ length: 100_000 }, (_, index) => [`plugin-${index}`, 'debug'] as const),
		),
	})

	bench('plugin policy allows hit among 100k overrides', () => {
		largePolicy.allows('plugin-99999', 'debug')
	})

	const sinkWithoutCaller = createRuntimeLogSink({
		registry: new RuntimeLogStoreRegistry(),
		streamId: 'bench-runtime-sink-no-caller',
		bufferSize: 1,
		flushIntervalMs: 0,
		windowLines: 1,
		caller: false,
	})
	const sinkRecord = record()

	bench('runtime UI sink append without caller', () => {
		sinkWithoutCaller(sinkRecord)
	})

	const sinkWithCaller = createRuntimeLogSink({
		registry: new RuntimeLogStoreRegistry(),
		streamId: 'bench-runtime-sink-caller',
		bufferSize: 1,
		flushIntervalMs: 0,
		windowLines: 1,
		caller: true,
	})

	bench('runtime UI sink append with caller capture', () => {
		sinkWithCaller(sinkRecord)
	})
})

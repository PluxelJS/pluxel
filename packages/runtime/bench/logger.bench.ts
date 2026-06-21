import { type LogRecord } from '@logtape/logtape'
import { createRuntimeLogSink, RuntimePluginLogPolicy } from '@pluxel/runtime/logger'
import { bench, describe } from 'vitest'

function record(input: Partial<LogRecord> = {}): LogRecord {
	return {
		category: ['pluxel', 'plugins'],
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
		defaultLevel: 'info',
		overrides: {
			'plugin-42': 'debug',
			'plugin-off': 'off',
		},
	})
	const policyRecord = record()

	bench('plugin policy allows override hit', () => {
		policy.allows(policyRecord)
	})

	const sinkWithoutCaller = createRuntimeLogSink({
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

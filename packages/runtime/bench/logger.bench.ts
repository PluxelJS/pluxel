import { type LogRecord } from '@logtape/logtape'
import type { PluginNodeAddress } from '@pluxel/core'
import { pluginLogCategory } from '@pluxel/core/logger'
import { RuntimePluginLogPolicy } from '@pluxel/runtime/logger'
import { bench, describe } from 'vitest'
import { createRuntimeLogSink } from '../src/logger/sink'
import { RuntimeLogStoreRegistry } from '../src/logger/store'

function pluginAddress(index: number): PluginNodeAddress {
	return {
		definition: {
			entry: { kind: 'package-root', packageName: `@bench/plugin-${index}` },
			exportName: 'Plugin',
		},
		variant: 'default',
	}
}

const plugin42 = pluginAddress(42)

function record(input: Partial<LogRecord> = {}): LogRecord {
	return {
		category: pluginLogCategory('bench-root', plugin42),
		level: 'debug',
		message: ['plugin message ', 42, { nested: { ok: true } }],
		properties: {
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
		version: 3,
		defaultLevel: 'info',
		overrides: [
			{ owner: plugin42, level: 'debug' },
			{ owner: pluginAddress(-1), level: 'off' },
		],
	})
	bench('plugin policy allows override hit', () => {
		policy.allows(plugin42, 'debug')
	})

	const largePolicy = new RuntimePluginLogPolicy({
		version: 3,
		defaultLevel: 'info',
		overrides: Array.from({ length: 100_000 }, (_, index) => ({
			owner: pluginAddress(index),
			level: 'debug' as const,
		})),
	})

	bench('plugin policy allows hit among 100k overrides', () => {
		largePolicy.allows(pluginAddress(99_999), 'debug')
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

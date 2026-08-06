import { afterAll, bench, describe } from 'vitest'
import type {
	CapacityLimit,
	MetricsRecorder,
	OperationMetric,
	OperationResult,
} from '../src/recorder.ts'
import { OperationMetricsRuntime, type MetricsOwnerContext } from '../src/runtime.ts'

const options = { time: 500, warmupTime: 100, iterations: 10, warmupIterations: 5 }
let benchmarkSink: unknown

class BenchmarkRecorder implements MetricsRecorder {
	calls = 0
	durationSeconds = 0

	record(_operation: OperationMetric, _result: OperationResult, durationSeconds: number): void {
		this.calls += 1
		this.durationSeconds = durationSeconds
	}

	recordCapacityDrop(_limit: CapacityLimit): void {}

	async shutdown(): Promise<void> {}
}

function createOwner(pluginId: string): MetricsOwnerContext {
	return {
		pluginInfo: { id: pluginId },
		effects: {
			defer() {
				return { active: true }
			},
		},
	}
}

const recorder = new BenchmarkRecorder()
const runtime = new OperationMetricsRuntime({ warn() {} })
const owner = createOwner('BenchmarkConsumer')
const operations = Array.from({ length: 128 }, (_, index) => 'operation.' + index)
const resolved = Promise.resolve(42)
runtime.start(recorder)
for (const operation of operations) runtime.measure(owner, operation, () => 42)

afterAll(() => {
	runtime.stop()
	benchmarkSink = { benchmarkSink, calls: recorder.calls, duration: recorder.durationSeconds }
})

describe('operation metrics hot path', () => {
	bench(
		'direct synchronous callback',
		() => {
			benchmarkSink = 42
		},
		options,
	)

	bench(
		'measured synchronous callback, cached operation',
		() => {
			benchmarkSink = runtime.measure(owner, operations[0]!, () => 42)
		},
		options,
	)

	bench(
		'direct fulfilled promise',
		async () => {
			benchmarkSink = await resolved
		},
		options,
	)

	bench(
		'measured fulfilled promise, cached operation',
		async () => {
			benchmarkSink = await runtime.measure(owner, operations[0]!, () => resolved)
		},
		options,
	)

	let operationIndex = 0
	bench(
		'measured synchronous callback across 128 cached operations',
		() => {
			operationIndex = (operationIndex + 1) & 127
			benchmarkSink = runtime.measure(owner, operations[operationIndex]!, () => 42)
		},
		options,
	)
})

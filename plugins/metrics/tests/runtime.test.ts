import { describe, expect, it } from 'vitest'
import { MAX_OPERATIONS, MAX_OPERATIONS_PER_PLUGIN } from '../src/constants.ts'
import type {
	CapacityLimit,
	MetricsRecorder,
	OperationMetric,
	OperationResult,
} from '../src/recorder.ts'
import {
	OperationMetricsRuntime,
	type MetricsOwnerContext,
	type MetricsRuntimeLogger,
} from '../src/runtime.ts'

class FakeRecorder implements MetricsRecorder {
	readonly records: Array<{
		operation: OperationMetric
		result: OperationResult
		durationSeconds: number
	}> = []
	readonly drops: CapacityLimit[] = []
	recordError: Error | undefined

	record(operation: OperationMetric, result: OperationResult, durationSeconds: number): void {
		if (this.recordError) throw this.recordError
		this.records.push({ operation, result, durationSeconds })
	}

	recordCapacityDrop(limit: CapacityLimit): void {
		if (this.recordError) throw this.recordError
		this.drops.push(limit)
	}

	async shutdown(): Promise<void> {}
}

function createOwner(pluginId: string): MetricsOwnerContext & { dispose(): void } {
	const cleanups: Array<() => void> = []
	return {
		pluginInfo: { id: pluginId },
		effects: {
			defer(cleanup) {
				cleanups.push(cleanup)
				return { active: true }
			},
		},
		dispose() {
			for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
		},
	}
}

function createRuntime(): {
	runtime: OperationMetricsRuntime
	recorder: FakeRecorder
	warnings: Array<Readonly<Record<string, unknown>> | undefined>
} {
	const warnings: Array<Readonly<Record<string, unknown>> | undefined> = []
	const logger: MetricsRuntimeLogger = {
		warn(_message, properties) {
			warnings.push(properties)
		},
	}
	const runtime = new OperationMetricsRuntime(logger)
	const recorder = new FakeRecorder()
	runtime.start(recorder)
	return { runtime, recorder, warnings }
}

describe('operation metrics runtime', () => {
	it('records sync and async completion without changing results', async () => {
		const { runtime, recorder } = createRuntime()
		const owner = createOwner('Consumer')
		const returned = { value: 1 }
		const syncError = new Error('sync')
		const asyncError = new Error('async')

		expect(runtime.measure(owner, 'sync.ok', () => returned)).toBe(returned)
		expect(() =>
			runtime.measure(owner, 'sync.error', () => {
				throw syncError
			}),
		).toThrow(syncError)
		await expect(runtime.measure(owner, 'async.ok', () => Promise.resolve(returned))).resolves.toBe(
			returned,
		)
		await expect(
			runtime.measure(owner, 'async.error', () => Promise.reject(asyncError)),
		).rejects.toBe(asyncError)

		expect(recorder.records.map(({ operation, result }) => [operation.operation, result])).toEqual([
			['sync.ok', 'ok'],
			['sync.error', 'error'],
			['async.ok', 'ok'],
			['async.error', 'error'],
		])
		expect(recorder.records.every(({ durationSeconds }) => durationSeconds >= 0)).toBe(true)
		expect(recorder.records[0]!.operation.okAttributes).toEqual({
			'pluxel.plugin.id': 'Consumer',
			'pluxel.operation.name': 'sync.ok',
			'pluxel.operation.result': 'ok',
		})
	})

	it('normalizes thenables to Promise and ignores late settlement after owner cleanup', async () => {
		const { runtime, recorder } = createRuntime()
		const owner = createOwner('Consumer')
		let resolve!: (value: number) => void
		const pending = new Promise<number>((settle) => {
			resolve = settle
		})
		const thenable: PromiseLike<number> = {
			// oxlint-disable-next-line unicorn/no-thenable -- this fixture verifies bare PromiseLike normalization
			then: pending.then.bind(pending),
		}

		const result = runtime.measure(owner, 'pending', () => thenable)
		expect(result).toBeInstanceOf(Promise)
		owner.dispose()
		resolve(42)
		await expect(result).resolves.toBe(42)
		expect(recorder.records).toEqual([])
	})

	it.each(['', ' padded', 'padded ', 'control\u0000', 'unpaired\ud800', 'é'.repeat(65)])(
		'rejects invalid operation %j before running business code',
		(operation) => {
			const { runtime } = createRuntime()
			const owner = createOwner('Consumer')
			let calls = 0
			expect(() =>
				runtime.measure(owner, operation, () => {
					calls += 1
				}),
			).toThrow(TypeError)
			expect(calls).toBe(0)
		},
	)

	it('enforces the per-plugin limit without retaining rejected names', () => {
		const { runtime, recorder, warnings } = createRuntime()
		const owner = createOwner('Consumer')
		for (let index = 0; index < MAX_OPERATIONS_PER_PLUGIN; index += 1) {
			expect(runtime.measure(owner, 'operation.' + index, () => index)).toBe(index)
		}
		expect(runtime.measure(owner, 'overflow', () => 999)).toBe(999)
		expect(recorder.records).toHaveLength(MAX_OPERATIONS_PER_PLUGIN)
		expect(recorder.drops).toEqual(['per_plugin'])
		expect(warnings).toEqual([
			expect.objectContaining({ limit: 'per_plugin', pluginId: 'Consumer' }),
		])
	})

	it('enforces the total limit across plugins', () => {
		const { runtime, recorder } = createRuntime()
		for (let plugin = 0; plugin < MAX_OPERATIONS / MAX_OPERATIONS_PER_PLUGIN; plugin += 1) {
			const owner = createOwner('Consumer' + plugin)
			for (let operation = 0; operation < MAX_OPERATIONS_PER_PLUGIN; operation += 1) {
				runtime.measure(owner, 'operation.' + operation, (): void => undefined)
			}
		}
		const overflowOwner = createOwner('Overflow')
		runtime.measure(overflowOwner, 'operation', (): void => undefined)
		expect(recorder.records).toHaveLength(MAX_OPERATIONS)
		expect(recorder.drops).toEqual(['total'])
	})

	it('holds retiring capacity until collection and reuses the same identity', () => {
		const { runtime, recorder } = createRuntime()
		const first = createOwner('Consumer')
		for (let index = 0; index < MAX_OPERATIONS_PER_PLUGIN; index += 1) {
			runtime.measure(first, 'old.' + index, (): void => undefined)
		}
		first.dispose()

		const replacement = createOwner('Consumer')
		runtime.measure(replacement, 'old.0', (): void => undefined)
		runtime.measure(replacement, 'new', (): void => undefined)
		expect(recorder.drops).toEqual(['per_plugin'])

		runtime.onCollection()
		runtime.measure(replacement, 'new', (): void => undefined)
		expect(recorder.records.at(-1)!.operation.operation).toBe('new')
	})

	it('preserves business results when recording fails or runtime is stopped', () => {
		const { runtime, recorder, warnings } = createRuntime()
		const owner = createOwner('Consumer')
		recorder.recordError = new Error('recorder')
		expect(runtime.measure(owner, 'recording.failure', () => 1)).toBe(1)
		expect(warnings).toHaveLength(1)

		runtime.stop()
		const resolved = Promise.resolve(2)
		const thenable: PromiseLike<number> = {
			// oxlint-disable-next-line unicorn/no-thenable -- this fixture verifies the unmeasured PromiseLike path
			then: resolved.then.bind(resolved),
		}
		expect(runtime.measure(owner, 'stopped', () => 2)).toBe(2)
		expect(runtime.measure(owner, 'stopped.async', () => thenable)).toBeInstanceOf(Promise)
	})
})

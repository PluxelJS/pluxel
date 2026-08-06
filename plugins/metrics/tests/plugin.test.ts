import { BasePlugin, Plugin, withHost } from '@pluxel/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MetricsPlugin } from '../src/index.ts'
import type {
	CapacityLimit,
	MetricsRecorder,
	OperationMetric,
	OperationResult,
	RecorderHooks,
} from '../src/recorder.ts'

type MockRecorder = MetricsRecorder & {
	readonly records: Array<{ operation: OperationMetric; result: OperationResult }>
	readonly drops: CapacityLimit[]
	shutdownCalls: number
}

type CreatedRecorder = {
	readonly hooks: RecorderHooks
	readonly recorder: MockRecorder
}

const mockState = vi.hoisted(() => ({
	created: [] as CreatedRecorder[],
}))

vi.mock('../src/otel.ts', () => ({
	createOtlpRecorder: vi.fn(async (input: { hooks: RecorderHooks }) => {
		const recorder: MockRecorder = {
			records: [],
			drops: [],
			shutdownCalls: 0,
			record(operation, result) {
				this.records.push({ operation, result })
			},
			recordCapacityDrop(limit) {
				this.drops.push(limit)
			},
			async shutdown() {
				this.shutdownCalls += 1
			},
		}
		mockState.created.push({ hooks: input.hooks, recorder })
		return recorder
	}),
}))

@Plugin({ name: 'MetricsConsumer' })
class Consumer extends BasePlugin {
	constructor(readonly metrics: MetricsPlugin) {
		super()
	}

	run<T>(operation: string, callback: () => T): T {
		return this.metrics.measure(operation, callback)
	}

	runAsync<T>(operation: string, callback: () => PromiseLike<T>): Promise<T> {
		return this.metrics.measure(operation, callback)
	}
}

@Plugin({ name: 'SecondMetricsConsumer' })
class SecondConsumer extends BasePlugin {
	constructor(readonly metrics: MetricsPlugin) {
		super()
	}

	run<T>(operation: string, callback: () => T): T {
		return this.metrics.measure(operation, callback)
	}
}

beforeEach(() => {
	mockState.created.length = 0
})

describe('MetricsPlugin lifecycle', () => {
	it('binds measurements to the caller plugin identity', async () => {
		await withHost(async (host) => {
			host.add([MetricsPlugin, Consumer, SecondConsumer])
			await host.commit()
			const consumer = host.require(Consumer)
			const value = { ok: true }

			expect(consumer.run('sync', () => value)).toBe(value)
			await expect(consumer.runAsync('async', () => Promise.resolve(value))).resolves.toBe(value)
			expect(host.require(SecondConsumer).run('sync', () => value)).toBe(value)

			const records = mockState.created[0]!.recorder.records
			expect(records.map(({ operation, result }) => [operation.pluginId, result])).toEqual([
				['MetricsConsumer', 'ok'],
				['MetricsConsumer', 'ok'],
				['SecondMetricsConsumer', 'ok'],
			])
		})
		expect(mockState.created[0]!.recorder.shutdownCalls).toBe(1)
	})

	it('uses normal graph validation for the required capability', async () => {
		await withHost(async (host) => {
			host.add(Consumer)
			await expect(host.commit()).rejects.toThrow(/service verification failed/)
			expect(host.isRunning(Consumer)).toBe(false)
		})
	})

	it('ignores async settlement after the consumer generation stops', async () => {
		await withHost(async (host) => {
			host.add([MetricsPlugin, Consumer])
			await host.commit()
			let resolve!: (value: number) => void
			const pending = new Promise<number>((settle) => {
				resolve = settle
			})
			const result = host.require(Consumer).runAsync('pending', () => pending)

			host.remove(Consumer)
			await host.commit()
			resolve(42)
			await expect(result).resolves.toBe(42)
			expect(mockState.created[0]!.recorder.records).toEqual([])
		})
	})

	it('revokes old views and starts a fresh recorder across provider restart', async () => {
		await withHost(async (host) => {
			host.add([MetricsPlugin, Consumer])
			await host.commit()
			const oldConsumer = host.require(Consumer)
			expect(oldConsumer.run('before', () => 1)).toBe(1)

			host.restart(MetricsPlugin, { cascadeDependents: true })
			await host.commit()
			expect(mockState.created).toHaveLength(2)

			expect(oldConsumer.run('old-view', () => 2)).toBe(2)
			expect(
				mockState.created[0]!.recorder.records.map((record) => record.operation.operation),
			).toEqual(['before'])

			const current = host.require(Consumer)
			expect(current.run('after', () => 3)).toBe(3)
			expect(mockState.created[1]!.recorder.records[0]!.operation.operation).toBe('after')
		})
		expect(mockState.created.every(({ recorder }) => recorder.shutdownCalls === 1)).toBe(true)
	})

	it('reclaims retiring registrations after local collection', async () => {
		await withHost(async (host) => {
			host.add([MetricsPlugin, Consumer])
			await host.commit()
			host.require(Consumer).run('first', (): void => undefined)
			host.remove(Consumer)
			await host.commit()
			mockState.created[0]!.hooks.onCollection()

			host.add(Consumer)
			await host.commit()
			host.require(Consumer).run('second', (): void => undefined)
			expect(
				mockState.created[0]!.recorder.records.map((record) => record.operation.operation),
			).toEqual(['first', 'second'])
		})
	})
})

import { SHARE_ENV } from 'node:worker_threads'
import { BasePlugin, Plugin } from '@pluxel/core'
import { nodeModules } from '@pluxel/services/node'
import { defineWorkerTask, workers, type WorkersConfig } from '@pluxel/services/workers'
import { createTestHost } from '@pluxel/test'
import { expect, it, vi } from 'vitest'
import type { Input, Output } from './fixtures/worker-native-options'

const task = defineWorkerTask<Input, Output>(import.meta.url, './fixtures/worker-native-options.ts')
const envKey = 'PLUXEL_NATIVE_WORKER_TEST'

@Plugin()
class Consumer extends BasePlugin {
	observe(input: Input = { envKey }) {
		return this.ctx.workers.run(task, input)
	}
}

it('uses native env, execArgv, argv, name, workerData and resource limits', async () => {
	const native = {
		env: { [envKey]: 'configured' },
		execArgv: ['--no-warnings'],
		argv: ['native-argument'],
		name: 'pluxel-native-options',
		workerData: new Map([['startup', 'native']]),
		resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
	} satisfies NonNullable<WorkersConfig['worker']>
	const service = workers({ maxThreads: 1, worker: native })
	native.env[envKey] = 'changed after descriptor creation'
	native.execArgv.push('--trace-warnings')
	native.argv.push('changed argument')
	native.resourceLimits.maxOldGenerationSizeMb = 96
	await using host = await createTestHost({ services: [nodeModules(), service] })
	const consumer = await host.start(Consumer)
	expect(await consumer.observe()).toMatchObject({
		value: 'configured',
		execArgv: ['--no-warnings'],
		argv: [process.execPath, 'native-argument'],
		threadName: 'pluxel-native-options',
		workerData: new Map([['startup', 'native']]),
		resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
	})
})

it('preserves native SHARE_ENV instead of cloning or serializing it', async () => {
	vi.stubEnv(envKey, 'before worker')
	try {
		await using host = await createTestHost({
			services: [nodeModules(), workers({ maxThreads: 1, worker: { env: SHARE_ENV } })],
		})
		const consumer = await host.start(Consumer)
		expect(await consumer.observe({ envKey, writeValue: 'written by worker' })).toMatchObject({
			value: 'written by worker',
		})
		expect(process.env[envKey]).toBe('written by worker')
	} finally {
		vi.unstubAllEnvs()
	}
})

it.each(['eval', 'transferList', 'stdin', 'stdout', 'stderr'])(
	'rejects managed native option %s before creating a service or worker',
	(key) => {
		expect(() => Reflect.apply(workers, undefined, [{ worker: { [key]: undefined } }])).toThrow(
			`workers.worker.${key} is owned by the task entry and lifecycle`,
		)
	},
)

it('rejects an inherited managed thread option', () => {
	expect(() => workers({ worker: Object.create({ eval: false }) })).toThrow('workers.worker.eval')
})

it.each([null, false, 3, 'worker', []])(
	'rejects a non-object native options input: %j',
	(worker) => {
		expect(() => Reflect.apply(workers, undefined, [{ worker }])).toThrow('thread options object')
	},
)

it('retains native creation failures and releases task admission for queued work and shutdown', async () => {
	const service = workers({ maxThreads: 1, worker: { execArgv: ['--max-old-space-size=32'] } })
	await using host = await createTestHost({ services: [nodeModules(), service] })
	const consumer = await host.start(Consumer)
	const attempts = await Promise.allSettled([consumer.observe(), consumer.observe()])
	for (const attempt of attempts) {
		expect(attempt).toMatchObject({
			status: 'rejected',
			reason: { code: 'TASK_FAILED', cause: { code: 'ERR_WORKER_INVALID_EXEC_ARGV' } },
		})
	}
	await host.stop(Consumer)
})

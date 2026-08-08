import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defineWorkerTask, type WorkerTaskError } from '@pluxel/runtime'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'

type TaskInput = Readonly<{ label: string; delay: number }>
type TaskOutput = Readonly<{
	label: string
	threadId: number
	started: number
	ended: number
}>

const artifactKey = 'worker-task'
const declaration = (defineWorkerTask as unknown as (...args: unknown[]) => unknown)(
	import.meta.url,
	'./fixtures/worker-task.mjs',
	artifactKey,
) as ReturnType<typeof defineWorkerTask<TaskInput, TaskOutput>>
const artifactRoot = dirname(fileURLToPath(new URL('./fixtures/worker-task.mjs', import.meta.url)))

@Plugin({ name: 'WorkerTaskConsumerA' })
class WorkerTaskConsumerA extends BasePlugin {
	run(input: TaskInput, signal?: AbortSignal): Promise<TaskOutput> {
		return this.ctx.workers.run(declaration, input, { signal })
	}
}

@Plugin({ name: 'WorkerTaskConsumerB' })
class WorkerTaskConsumerB extends BasePlugin {
	run(input: TaskInput): Promise<TaskOutput> {
		return this.ctx.workers.run(declaration, input)
	}
}

function createWorkerHost(
	workers: NonNullable<Parameters<typeof createRuntimeHost>[0]>['workers'] = {},
) {
	return createRuntimeHost({
		workbench: false,
		nodeModuleArtifactRoot: artifactRoot,
		workers,
	})
}

describe('WorkerTaskService', () => {
	it('lazily runs cloneable task data in a worker thread', async () => {
		const host = createWorkerHost({ maxThreads: 1 })
		try {
			const rootWorkers = host.ctx.workers as unknown as {
				state?: { pool?: unknown }
			}
			expect(rootWorkers.state?.pool).toBeUndefined()
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()

			const result = await host.require(WorkerTaskConsumerA).run({ label: 'worker', delay: 0 })
			expect(result.label).toBe('worker')
			expect(result.threadId).toBeGreaterThan(0)
			expect(rootWorkers.state?.pool).toBeDefined()
			await expect(
				host.require(WorkerTaskConsumerA).run({
					label: 'bad',
					delay: (() => 0) as unknown as number,
				}),
			).rejects.toMatchObject<Partial<WorkerTaskError>>({ code: 'INVALID_INPUT' })
		} finally {
			await host.dispose()
		}
	})

	it('shares one budget and dispatches queued owners round-robin', async () => {
		const host = createWorkerHost({ maxThreads: 1 })
		try {
			host.add([WorkerTaskConsumerA, WorkerTaskConsumerB])
			host.cfg(WorkerTaskConsumerA).enable()
			host.cfg(WorkerTaskConsumerB).enable()
			await host.commit()
			const a = host.require(WorkerTaskConsumerA)
			const b = host.require(WorkerTaskConsumerB)
			const completed: string[] = []
			const first = a.run({ label: 'a1', delay: 80 }).then((result) => {
				completed.push(result.label)
				return result
			})
			const secondA = a.run({ label: 'a2', delay: 0 }).then((result) => {
				completed.push(result.label)
				return result
			})
			const firstB = b.run({ label: 'b1', delay: 0 }).then((result) => {
				completed.push(result.label)
				return result
			})

			const results = await Promise.all([first, secondA, firstB])
			expect(completed).toEqual(['a1', 'b1', 'a2'])
			expect(new Set(results.map((result) => result.threadId)).size).toBe(1)
		} finally {
			await host.dispose()
		}
	})

	it('bounds each owner queue independently', async () => {
		const host = createWorkerHost({
			maxThreads: 1,
			maxQueuedTasks: 8,
			maxQueuedTasksPerPlugin: 1,
		})
		try {
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()
			const consumer = host.require(WorkerTaskConsumerA)
			const running = consumer.run({ label: 'running', delay: 100 })
			const queued = consumer.run({ label: 'queued', delay: 0 })
			await expect(consumer.run({ label: 'rejected', delay: 0 })).rejects.toMatchObject<
				Partial<WorkerTaskError>
			>({ code: 'OWNER_QUEUE_FULL' })
			await Promise.all([running, queued])
		} finally {
			await host.dispose()
		}
	})

	it('bounds the root queue across different plugin owners', async () => {
		const host = createWorkerHost({
			maxThreads: 1,
			maxQueuedTasks: 1,
			maxQueuedTasksPerPlugin: 8,
		})
		try {
			host.add([WorkerTaskConsumerA, WorkerTaskConsumerB])
			host.cfg(WorkerTaskConsumerA).enable()
			host.cfg(WorkerTaskConsumerB).enable()
			await host.commit()
			const a = host.require(WorkerTaskConsumerA)
			const b = host.require(WorkerTaskConsumerB)
			const running = a.run({ label: 'running', delay: 100 })
			const queued = a.run({ label: 'queued', delay: 0 })
			await expect(b.run({ label: 'rejected', delay: 0 })).rejects.toMatchObject<
				Partial<WorkerTaskError>
			>({ code: 'QUEUE_FULL' })
			await Promise.all([running, queued])
		} finally {
			await host.dispose()
		}
	})

	it('removes a cancelled queue slot so the owner can submit again', async () => {
		const host = createWorkerHost({ maxThreads: 1 })
		try {
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()
			const consumer = host.require(WorkerTaskConsumerA)
			const running = consumer.run({ label: 'running', delay: 80 })
			const controller = new AbortController()
			const reason = new Error('cancel queued')
			const cancelled = consumer.run({ label: 'cancelled', delay: 0 }, controller.signal)
			controller.abort(reason)
			await expect(cancelled).rejects.toBe(reason)
			await running
			await expect(consumer.run({ label: 'next', delay: 0 })).resolves.toMatchObject({
				label: 'next',
			})
		} finally {
			await host.dispose()
		}
	})

	it('aborts accepted work and waits for it when its plugin owner stops', async () => {
		const host = createWorkerHost({ maxThreads: 1 })
		try {
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()
			const task = host.require(WorkerTaskConsumerA).run({ label: 'long', delay: 10_000 })
			host.remove(WorkerTaskConsumerA)
			await host.commit()
			await expect(task).rejects.toMatchObject<Partial<WorkerTaskError>>({
				code: 'NOT_RUNNING',
			})
		} finally {
			await host.dispose()
		}
	})
})

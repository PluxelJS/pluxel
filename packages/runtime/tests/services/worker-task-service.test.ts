import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineWorkerTask, type WorkerTaskError } from '@pluxel/runtime'
import { BasePlugin, createRuntimeHost, Plugin, type RuntimeHost } from '@pluxel/runtime/test'

type TaskInput = Readonly<{ label: string; delay: number }>
type TaskOutput = Readonly<{
	label: string
	threadId: number
	started: number
	ended: number
}>

type TransferTaskInput = Readonly<{ bytes: Uint8Array }>
type TransferTaskOutput = Readonly<{
	byteLength: number
	first: number
	last: number
	threadId: number
}>

const artifactKey = 'worker-task'
const declaration = (defineWorkerTask as unknown as (...args: unknown[]) => unknown)(
	import.meta.url,
	'./fixtures/worker-task.mjs',
	artifactKey,
) as ReturnType<typeof defineWorkerTask<TaskInput, TaskOutput>>
const transferDeclaration = (defineWorkerTask as unknown as (...args: unknown[]) => unknown)(
	import.meta.url,
	'./fixtures/worker-transfer.mjs',
	'worker-transfer',
) as ReturnType<typeof defineWorkerTask<TransferTaskInput, TransferTaskOutput>>
const artifactRoot = dirname(fileURLToPath(new URL('./fixtures/worker-task.mjs', import.meta.url)))

@Plugin()
class WorkerTaskConsumerA extends BasePlugin {
	workerView() {
		return this.ctx.workers
	}

	run(input: TaskInput, signal?: AbortSignal): Promise<TaskOutput> {
		return this.ctx.workers.run(declaration, input, { signal })
	}

	borrow(input: TaskInput): Promise<TaskOutput> {
		return this.ctx.workers.run(declaration, input, { inputOwnership: 'borrowed' })
	}

	prepare(
		prepare: (signal: AbortSignal) => TaskInput | Promise<TaskInput>,
		signal?: AbortSignal,
	): Promise<TaskOutput> {
		return this.ctx.workers.runPrepared(declaration, prepare, {
			signal,
			inputOwnership: 'borrowed',
		})
	}

	prepareWithTransfer(): Promise<TaskOutput> {
		return this.ctx.workers.runPrepared(declaration, async () => ({ label: 'invalid', delay: 0 }), {
			transfer: [],
		} as never)
	}

	transfer(
		input: TransferTaskInput,
		transfer: readonly ArrayBuffer[],
	): Promise<TransferTaskOutput> {
		return this.ctx.workers.run(transferDeclaration, input, { transfer })
	}
}

@Plugin()
class WorkerTaskConsumerB extends BasePlugin {
	workerView() {
		return this.ctx.workers
	}

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

async function resetWorkerHost(host: RuntimeHost): Promise<void> {
	const plugins = host.plugins()
	if (plugins.length === 0) return
	host.remove(plugins)
	await host.commit()
}

type WorkerTaskRootStateProbe = {
	activeTasks: number
	queuedTasks: number
	pool: {
		slots: Set<{ worker: { terminate(): Promise<number> } }>
	}
}

function holdCurrentWorkerTermination(host: RuntimeHost): Readonly<{
	state: WorkerTaskRootStateProbe
	release(): void
}> {
	const state = (host.ctx.workers as unknown as { state: WorkerTaskRootStateProbe }).state
	const worker = [...state.pool.slots][0]!.worker
	const terminate = worker.terminate.bind(worker)
	let release!: () => void
	const gate = new Promise<void>((resolve) => void (release = resolve))
	worker.terminate = async () => {
		await gate
		return terminate()
	}
	return { state, release }
}

describe('WorkerTaskService', () => {
	let workerHost: RuntimeHost

	beforeAll(() => {
		workerHost = createWorkerHost({ maxThreads: 1 })
	})

	afterAll(() => workerHost.dispose())

	it('creates cold owner views per consumer while sharing one root coordinator', async () => {
		const host = createWorkerHost({ maxThreads: 1 })
		try {
			host.add([WorkerTaskConsumerA, WorkerTaskConsumerB])
			host.cfg(WorkerTaskConsumerA).enable()
			host.cfg(WorkerTaskConsumerB).enable()
			await host.commit()

			const rootView = host.ctx.workers
			const a = host.require(WorkerTaskConsumerA)
			const b = host.require(WorkerTaskConsumerB)
			const aView = a.workerView()
			const bView = b.workerView()

			expect(aView).not.toBe(rootView)
			expect(bView).not.toBe(rootView)
			expect(aView).not.toBe(bView)
			expect(a.workerView()).toBe(aView)
			expect(b.workerView()).toBe(bView)
			expect(aView.ctx).toBe(a.ctx)
			expect(bView.ctx).toBe(b.ctx)
			expect((rootView as unknown as { state?: { pool?: unknown } }).state?.pool).toBeUndefined()
		} finally {
			await host.dispose()
		}
	})

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

	it('moves explicitly transferred buffers without changing the shared pool contract', async () => {
		const host = workerHost
		try {
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()
			const bytes = new Uint8Array(64 * 1024)
			bytes[0] = 17
			bytes[bytes.byteLength - 1] = 29
			const buffer = bytes.buffer
			const result = host.require(WorkerTaskConsumerA).transfer({ bytes }, [buffer])

			expect(buffer.byteLength).toBe(0)
			await expect(result).resolves.toMatchObject({
				byteLength: 64 * 1024,
				first: 17,
				last: 29,
				threadId: expect.any(Number),
			})
		} finally {
			await resetWorkerHost(host)
		}
	})

	it('distinguishes admission snapshots from explicitly borrowed input', async () => {
		const host = createWorkerHost({ maxThreads: 1 })
		try {
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()
			const consumer = host.require(WorkerTaskConsumerA)
			const occupied = consumer.run({ label: 'occupied', delay: 50 })
			const snapshotInput = { label: 'snapshot', delay: 0 }
			const borrowedInput = { label: 'borrowed', delay: 0 }
			const snapshot = consumer.run(snapshotInput)
			const borrowed = consumer.borrow(borrowedInput)
			snapshotInput.label = 'mutated snapshot'
			borrowedInput.label = 'mutated borrowed'

			await occupied
			await expect(snapshot).resolves.toMatchObject({ label: 'snapshot' })
			await expect(borrowed).resolves.toMatchObject({ label: 'mutated borrowed' })
		} finally {
			await host.dispose()
		}
	})

	it('rejects transfer ownership on deferred input preparation', async () => {
		const host = createWorkerHost()
		try {
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()
			await expect(host.require(WorkerTaskConsumerA).prepareWithTransfer()).rejects.toMatchObject<
				Partial<WorkerTaskError>
			>({ code: 'INVALID_INPUT' })
		} finally {
			await host.dispose()
		}
	})

	it('validates transfer ownership before detaching caller buffers', async () => {
		const host = workerHost
		try {
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()
			const bytes = new Uint8Array(16)
			const buffer = bytes.buffer

			await expect(
				host.require(WorkerTaskConsumerA).transfer({ bytes }, [buffer, buffer]),
			).rejects.toMatchObject<Partial<WorkerTaskError>>({ code: 'INVALID_INPUT' })
			expect(buffer.byteLength).toBe(16)
		} finally {
			await resetWorkerHost(host)
		}
	})

	it('shares one budget and dispatches queued owners round-robin', async () => {
		const host = workerHost
		try {
			host.add([WorkerTaskConsumerA, WorkerTaskConsumerB])
			host.cfg(WorkerTaskConsumerA).enable()
			host.cfg(WorkerTaskConsumerB).enable()
			await host.commit()
			const a = host.require(WorkerTaskConsumerA)
			const b = host.require(WorkerTaskConsumerB)
			// Resolve both owner-local artifact routes before exercising scheduler fairness.
			// Artifact readiness is intentionally independent and has no submission-order contract.
			await Promise.all([
				a.run({ label: 'warm-a', delay: 0 }),
				b.run({ label: 'warm-b', delay: 0 }),
			])
			const completed: string[] = []
			const first = a.run({ label: 'a1', delay: 20 }).then((result) => {
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
			await resetWorkerHost(host)
		}
	})

	it('snapshots queued inputs synchronously before callers can mutate them', async () => {
		const host = workerHost
		try {
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()
			const consumer = host.require(WorkerTaskConsumerA)
			const running = consumer.run({ label: 'running', delay: 20 })
			const queuedInput = { label: 'snapshot', delay: 0 }
			const queued = consumer.run(queuedInput)
			queuedInput.label = 'mutated'

			await running
			await expect(queued).resolves.toMatchObject({ label: 'snapshot' })
		} finally {
			await resetWorkerHost(host)
		}
	})

	it('bounds tasks while their shared artifact route is still resolving', async () => {
		const host = createWorkerHost({
			maxThreads: 1,
			maxQueuedTasks: 1,
			maxQueuedTasksPerPlugin: 8,
		})
		let releaseRoute!: () => void
		const routeGate = new Promise<void>((resolve) => void (releaseRoute = resolve))
		const detach = host.ctx.nodeModules.attachSourceBinder(async () => {
			await routeGate
			return {
				url: new URL('./fixtures/worker-task.mjs', import.meta.url),
				dispose: () => undefined,
			}
		})
		try {
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()
			const consumer = host.require(WorkerTaskConsumerA)
			const reserved = consumer.run({ label: 'reserved', delay: 0 })
			const queued = consumer.run({ label: 'queued', delay: 0 })

			await expect(consumer.run({ label: 'rejected', delay: 0 })).rejects.toMatchObject<
				Partial<WorkerTaskError>
			>({ code: 'QUEUE_FULL' })
			releaseRoute()
			await expect(Promise.all([reserved, queued])).resolves.toHaveLength(2)
		} finally {
			releaseRoute()
			detach()
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
			const running = consumer.run({ label: 'running', delay: 20 })
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
			const running = a.run({ label: 'running', delay: 20 })
			const queued = a.run({ label: 'queued', delay: 0 })
			await expect(b.run({ label: 'rejected', delay: 0 })).rejects.toMatchObject<
				Partial<WorkerTaskError>
			>({ code: 'QUEUE_FULL' })
			const bytes = new Uint8Array(16)
			await expect(a.transfer({ bytes }, [bytes.buffer as ArrayBuffer])).rejects.toMatchObject<
				Partial<WorkerTaskError>
			>({ code: 'QUEUE_FULL' })
			expect(bytes.byteLength).toBe(16)
			await Promise.all([running, queued])
		} finally {
			await host.dispose()
		}
	})

	it('starts deferred input preparation only after fair queue admission and dispatch', async () => {
		const host = createWorkerHost({
			maxThreads: 1,
			maxQueuedTasks: 1,
			maxQueuedTasksPerPlugin: 8,
		})
		try {
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()
			const consumer = host.require(WorkerTaskConsumerA)
			await consumer.run({ label: 'warm', delay: 0 })
			const running = consumer.run({ label: 'running', delay: 30 })
			let preparations = 0
			const prepared = consumer.prepare(async (signal) => {
				preparations += 1
				signal.throwIfAborted()
				return { label: 'prepared', delay: 0 }
			})
			await expect(
				consumer.prepare(async () => {
					preparations += 1
					return { label: 'rejected', delay: 0 }
				}),
			).rejects.toMatchObject<Partial<WorkerTaskError>>({ code: 'QUEUE_FULL' })

			await Promise.resolve()
			expect(preparations).toBe(0)
			await running
			await expect(prepared).resolves.toMatchObject({ label: 'prepared' })
			expect(preparations).toBe(1)
		} finally {
			await host.dispose()
		}
	})

	it('aborts active deferred preparation and drains it when the owner stops', async () => {
		const host = createWorkerHost({ maxThreads: 1 })
		try {
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()
			let entered!: () => void
			const prepared = new Promise<void>((resolve) => {
				entered = resolve
			})
			const task = host.require(WorkerTaskConsumerA).prepare(async (signal) => {
				entered()
				await new Promise<never>((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(signal.reason), { once: true })
				})
				return { label: 'unreachable', delay: 0 }
			})
			await prepared

			host.remove(WorkerTaskConsumerA)
			await host.commit()
			await expect(task).rejects.toMatchObject<Partial<WorkerTaskError>>({ code: 'NOT_RUNNING' })
		} finally {
			await host.dispose()
		}
	})

	it('removes a cancelled queue slot so the owner can submit again', async () => {
		const host = workerHost
		try {
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()
			const consumer = host.require(WorkerTaskConsumerA)
			const running = consumer.run({ label: 'running', delay: 20 })
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
			await resetWorkerHost(host)
		}
	})

	it('retains an active slot until the aborted worker has actually terminated', async () => {
		const host = workerHost
		let releaseTermination = (): void => undefined
		try {
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()
			const consumer = host.require(WorkerTaskConsumerA)
			await consumer.run({ label: 'warm', delay: 0 })
			const held = holdCurrentWorkerTermination(host)
			releaseTermination = held.release
			const controller = new AbortController()
			const reason = new Error('cancel active')
			const active = consumer.run({ label: 'active', delay: 10_000 }, controller.signal)
			controller.abort(reason)

			await expect(active).rejects.toBe(reason)
			let nextSettled = false
			const next = consumer
				.run({ label: 'after-termination', delay: 0 })
				.finally(() => void (nextSettled = true))
			await Promise.resolve()
			expect(nextSettled).toBe(false)
			expect(held.state.activeTasks).toBe(1)
			expect(held.state.queuedTasks).toBe(1)

			releaseTermination()
			await expect(next).resolves.toMatchObject({
				label: 'after-termination',
			})
		} finally {
			releaseTermination()
			await resetWorkerHost(host)
		}
	})

	it('aborts accepted work and waits for it when its plugin owner stops', async () => {
		const host = workerHost
		let releaseTermination = (): void => undefined
		try {
			host.add(WorkerTaskConsumerA)
			host.cfg(WorkerTaskConsumerA).enable()
			await host.commit()
			await host.require(WorkerTaskConsumerA).run({ label: 'warm', delay: 0 })
			const held = holdCurrentWorkerTermination(host)
			releaseTermination = held.release
			const task = host.require(WorkerTaskConsumerA).run({ label: 'long', delay: 10_000 })
			host.remove(WorkerTaskConsumerA)
			let commitSettled = false
			const committing = host.commit().finally(() => void (commitSettled = true))
			await expect(task).rejects.toMatchObject<Partial<WorkerTaskError>>({
				code: 'NOT_RUNNING',
			})
			await Promise.resolve()
			expect(commitSettled).toBe(false)

			releaseTermination()
			await committing
		} finally {
			releaseTermination()
			await resetWorkerHost(host)
		}
	})
})

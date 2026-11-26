import { expect, it } from 'vitest'
import * as v from 'valibot'
import { BasePlugin, parsePluginNodeAddress, Plugin } from '@pluxel/core'
import { createCoreTestHost } from '@pluxel/core/internal/test'

const QueueConfig = v.object({ connected: v.boolean() })
const allocatedQueues = new Set<JobQueue>()
let failingGeneration: 'construction' | 'config' | 'init' | undefined

@Plugin()
export class JobQueue extends BasePlugin {
	private readonly config = this.configs.use(QueueConfig)
	private open = false

	constructor() {
		super()
		const failure = failingGeneration
		allocatedQueues.add(this)
		this.ctx.effects.defer(() => {
			this.open = false
			allocatedQueues.delete(this)
			if (failure) throw new Error('queue release failed')
		})
		if (failure === 'construction') throw new Error('queue construction failed')
	}

	protected override init() {
		if (!this.config.connected) throw new Error('queue connection failed')
		this.open = true
	}

	take() {
		if (!this.open) throw new Error('queue is closed')
		return 'send invoice'
	}
}

@Plugin()
export class Dispatcher extends BasePlugin {
	readonly firstJob: string

	constructor(private readonly queue: JobQueue) {
		super()
		this.firstJob = queue.take()
	}

	work() {
		return this.queue.take()
	}
}

@Plugin()
export class StatusPage extends BasePlugin {}

const queue = JobQueue.nodeAddress()
const dispatcher = Dispatcher.nodeAddress()
const statusPage = StatusPage.nodeAddress()

async function launch(host: ReturnType<typeof createCoreTestHost>) {
	failingGeneration = undefined
	await host.commit((change) => {
		change.add(queue, { initialConfig: { connected: true } })
		return change.add([dispatcher, statusPage])
	})
}

it('rejects an invalid dependency edit before restarting the active queue', async () => {
	await using host = createCoreTestHost()
	await launch(host)
	const active = host.require(queue)
	const worker = host.require(dispatcher)
	expect(worker.firstJob).toBe('send invoice')

	await expect(
		host.commit((change) => {
			change.restart(queue)
			return change.dependencies.setOverride({
				consumer: dispatcher,
				requirement: JobQueue,
				provider: statusPage,
			})
		}),
	).rejects.toThrow(/override|provider/i)

	expect(host.require(queue)).toBe(active)
	expect(host.require(dispatcher)).toBe(worker)
	expect(worker.work()).toBe('send invoice')
})

it.each([
	{ phase: 'construction', connected: true, kind: 'resolve-failed' },
	{ phase: 'config', connected: 'invalid', kind: 'config-failed' },
	{ phase: 'init', connected: false, kind: 'start-failed' },
] as const)(
	'reports provider $phase and cleanup failures, blocks its jobs and recovers after repair',
	async ({ phase, connected, kind }) => {
		await using host = createCoreTestHost()
		await launch(host)
		const oldWorker = host.require(dispatcher)
		const monitoring = host.require(statusPage)
		expect(oldWorker.work()).toBe('send invoice')
		expect(allocatedQueues.size).toBe(1)

		failingGeneration = phase
		const failure = await host.commitExpectFail((change) => {
			change.config.patch(queue, { connected })
			return change.restart(queue)
		})
		expect(failure.lifecycleReport.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					plugin: parsePluginNodeAddress(queue),
					kind,
				}),
				expect.objectContaining({
					plugin: parsePluginNodeAddress(queue),
					kind: 'drain-failed',
					message: expect.stringContaining('queue release failed'),
				}),
				expect.objectContaining({
					plugin: parsePluginNodeAddress(dispatcher),
					kind: 'dependency-blocked',
					blockedBy: parsePluginNodeAddress(queue),
				}),
			]),
		)
		expect(host.isRunning(queue)).toBe(false)
		expect(host.isRunning(dispatcher)).toBe(false)
		expect(allocatedQueues.size).toBe(0)
		expect(() => oldWorker.work()).toThrow(/stopped|withdrawn/i)
		expect(host.require(statusPage)).toBe(monitoring)

		failingGeneration = undefined
		await host.commit((change) => change.config.patch(queue, { connected: true }))
		const repaired = host.require(dispatcher)
		expect(repaired.work()).toBe('send invoice')
		expect(host.require(statusPage)).toBe(monitoring)
	},
)

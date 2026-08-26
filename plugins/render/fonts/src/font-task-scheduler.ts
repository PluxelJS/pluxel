import { FontsError } from './errors.ts'

type ScheduledFontTask = {
	state: 'queued' | 'running' | 'settled'
	readonly owner: FontTaskSchedulerOwner
	readonly signal: AbortSignal
	readonly onAbort: () => void
	start(): void
	reject(reason: Error): void
}

export type FontTaskSchedulerOwner = {
	readonly queue: Set<ScheduledFontTask>
	ready: boolean
	active: boolean
}

/** Owner-fair admission for caller-triggered font copies, file reads and hashing. */
export class FontTaskScheduler {
	private readonly readyOwners: FontTaskSchedulerOwner[] = []
	private readonly owners = new Set<FontTaskSchedulerOwner>()
	private readonly activeCompletions = new Set<Promise<void>>()
	private activeTasks = 0
	private queuedTasks = 0
	private active = true

	constructor(
		private readonly maxConcurrent: number,
		private readonly maxQueued: number,
		private readonly maxQueuedPerOwner: number,
	) {}

	createOwner(): FontTaskSchedulerOwner {
		if (!this.active) throw new FontsError('NOT_RUNNING', 'Font task scheduler is stopped')
		const owner: FontTaskSchedulerOwner = { queue: new Set(), ready: false, active: true }
		this.owners.add(owner)
		return owner
	}

	run<T>(owner: FontTaskSchedulerOwner, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
		if (!this.active || !owner.active) {
			return Promise.reject(new FontsError('NOT_RUNNING', 'Font task owner is stopped'))
		}
		if (signal.aborted) return Promise.reject(abortReason(signal))

		return new Promise<T>((resolve, reject) => {
			let scheduled!: ScheduledFontTask
			const settle = (callback: () => void) => {
				if (scheduled.state === 'settled') return
				scheduled.state = 'settled'
				signal.removeEventListener('abort', scheduled.onAbort)
				callback()
			}
			scheduled = {
				state: 'queued',
				owner,
				signal,
				onAbort: () => this.cancelQueued(scheduled, abortReason(signal)),
				start: () => {
					if (scheduled.state !== 'queued') return
					scheduled.state = 'running'
					signal.removeEventListener('abort', scheduled.onAbort)
					this.activeTasks += 1
					const execution = Promise.resolve().then(task)
					void execution.then(
						(value) => settle(() => resolve(value)),
						(error: unknown) => settle(() => reject(error)),
					)
					let completion!: Promise<void>
					completion = execution
						.then(
							(): void => undefined,
							(): void => undefined,
						)
						.finally((): void => {
							this.activeCompletions.delete(completion)
							this.activeTasks -= 1
							this.dispatch()
						})
					this.activeCompletions.add(completion)
				},
				reject: (reason) => settle(() => reject(reason)),
			}

			if (this.activeTasks < this.maxConcurrent) {
				scheduled.start()
				return
			}
			if (this.queuedTasks >= this.maxQueued) {
				scheduled.reject(new FontsError('FONT_BUSY', 'Font task queue is full'))
				return
			}
			if (owner.queue.size >= this.maxQueuedPerOwner) {
				scheduled.reject(new FontsError('FONT_BUSY', 'Caller font task queue is full'))
				return
			}
			signal.addEventListener('abort', scheduled.onAbort, { once: true })
			owner.queue.add(scheduled)
			this.queuedTasks += 1
			this.enqueueOwner(owner)
		})
	}

	closeOwner(owner: FontTaskSchedulerOwner, reason: Error): void {
		if (!owner.active) return
		owner.active = false
		this.owners.delete(owner)
		this.removeReadyOwner(owner)
		for (const task of owner.queue) this.cancelQueued(task, reason)
	}

	async close(reason: Error): Promise<void> {
		if (!this.active) {
			await Promise.allSettled(this.activeCompletions)
			return
		}
		this.active = false
		for (const owner of this.owners) this.closeOwner(owner, reason)
		this.readyOwners.length = 0
		await Promise.allSettled(this.activeCompletions)
	}

	private dispatch(): void {
		while (this.active && this.activeTasks < this.maxConcurrent) {
			const owner = this.readyOwners.shift()
			if (!owner) return
			owner.ready = false
			if (!owner.active) continue
			const task = owner.queue.values().next().value as ScheduledFontTask | undefined
			if (!task) continue
			owner.queue.delete(task)
			this.queuedTasks -= 1
			if (owner.queue.size > 0) this.enqueueOwner(owner)
			task.start()
		}
	}

	private cancelQueued(task: ScheduledFontTask, reason: Error): void {
		if (task.state !== 'queued' || !task.owner.queue.delete(task)) return
		this.queuedTasks -= 1
		if (task.owner.queue.size === 0) this.removeReadyOwner(task.owner)
		task.reject(reason)
	}

	private enqueueOwner(owner: FontTaskSchedulerOwner): void {
		if (!owner.active || owner.ready || owner.queue.size === 0) return
		owner.ready = true
		this.readyOwners.push(owner)
	}

	private removeReadyOwner(owner: FontTaskSchedulerOwner): void {
		if (!owner.ready) return
		owner.ready = false
		const index = this.readyOwners.indexOf(owner)
		if (index >= 0) this.readyOwners.splice(index, 1)
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException('Font task aborted', 'AbortError')
}

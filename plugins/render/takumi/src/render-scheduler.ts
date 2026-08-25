import { TakumiError } from './errors.ts'

type ScheduledRender = {
	state: 'queued' | 'running' | 'settled'
	readonly owner: RenderSchedulerOwner
	readonly signal: AbortSignal
	readonly onAbort: () => void
	start(): void
	reject(reason: Error): void
}

export type RenderSchedulerOwner = {
	readonly queue: Set<ScheduledRender>
	ready: boolean
	active: boolean
}

export class RenderScheduler {
	private readonly readyOwners: RenderSchedulerOwner[] = []
	private readonly owners = new Set<RenderSchedulerOwner>()
	private activeRenders = 0
	private queuedRenders = 0
	private active = true

	constructor(
		private readonly maxConcurrent: number,
		private readonly maxQueued: number,
		private readonly maxQueuedPerOwner: number,
	) {}

	createOwner(): RenderSchedulerOwner {
		if (!this.active) throw new TakumiError('NOT_RUNNING', 'Takumi render scheduler is stopped')
		const owner: RenderSchedulerOwner = { queue: new Set(), ready: false, active: true }
		this.owners.add(owner)
		return owner
	}

	run<T>(owner: RenderSchedulerOwner, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
		if (!this.active || !owner.active) {
			return Promise.reject(new TakumiError('NOT_RUNNING', 'Takumi render owner is stopped'))
		}
		if (signal.aborted) return Promise.reject(abortReason(signal))

		return new Promise<T>((resolve, reject) => {
			let render!: ScheduledRender
			const settle = (callback: () => void) => {
				if (render.state === 'settled') return
				render.state = 'settled'
				signal.removeEventListener('abort', render.onAbort)
				callback()
			}
			render = {
				state: 'queued',
				owner,
				signal,
				onAbort: () => this.cancelQueued(render, abortReason(signal)),
				start: () => {
					if (render.state !== 'queued') return
					render.state = 'running'
					signal.removeEventListener('abort', render.onAbort)
					this.activeRenders += 1
					void Promise.resolve()
						.then(task)
						.then(
							(value) => settle(() => resolve(value)),
							(error: unknown) => settle(() => reject(error)),
						)
						.finally(() => {
							this.activeRenders -= 1
							this.dispatch()
						})
				},
				reject: (reason) => settle(() => reject(reason)),
			}

			if (this.activeRenders < this.maxConcurrent) {
				render.start()
				return
			}
			if (this.queuedRenders >= this.maxQueued) {
				render.reject(new TakumiError('RENDER_BUSY', 'Takumi render queue is full'))
				return
			}
			if (owner.queue.size >= this.maxQueuedPerOwner) {
				render.reject(new TakumiError('RENDER_BUSY', 'Caller Takumi render queue is full'))
				return
			}
			signal.addEventListener('abort', render.onAbort, { once: true })
			owner.queue.add(render)
			this.queuedRenders += 1
			this.enqueueOwner(owner)
		})
	}

	closeOwner(owner: RenderSchedulerOwner, reason: Error): void {
		if (!owner.active) return
		owner.active = false
		this.owners.delete(owner)
		this.removeReadyOwner(owner)
		for (const render of owner.queue) this.cancelQueued(render, reason)
	}

	close(reason: Error): void {
		if (!this.active) return
		this.active = false
		for (const owner of this.owners) this.closeOwner(owner, reason)
		this.readyOwners.length = 0
	}

	private dispatch(): void {
		while (this.active && this.activeRenders < this.maxConcurrent) {
			const owner = this.readyOwners.shift()
			if (!owner) return
			owner.ready = false
			if (!owner.active) continue
			const render = owner.queue.values().next().value as ScheduledRender | undefined
			if (!render) continue
			owner.queue.delete(render)
			this.queuedRenders -= 1
			if (owner.queue.size > 0) this.enqueueOwner(owner)
			render.start()
		}
	}

	private cancelQueued(render: ScheduledRender, reason: Error): void {
		if (render.state !== 'queued' || !render.owner.queue.delete(render)) return
		this.queuedRenders -= 1
		if (render.owner.queue.size === 0) this.removeReadyOwner(render.owner)
		render.reject(reason)
	}

	private enqueueOwner(owner: RenderSchedulerOwner): void {
		if (!owner.active || owner.ready || owner.queue.size === 0) return
		owner.ready = true
		this.readyOwners.push(owner)
	}

	private removeReadyOwner(owner: RenderSchedulerOwner): void {
		if (!owner.ready) return
		owner.ready = false
		const index = this.readyOwners.indexOf(owner)
		if (index >= 0) this.readyOwners.splice(index, 1)
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException('Takumi rendering aborted', 'AbortError')
}

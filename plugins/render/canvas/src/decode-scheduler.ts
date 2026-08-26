import { CanvasError } from './contracts.ts'

type ScheduledDecode = {
	state: 'queued' | 'running' | 'settled'
	readonly owner: DecodeSchedulerOwner
	readonly signal: AbortSignal
	readonly onAbort: () => void
	start(): void
	reject(reason: Error): void
}

export type DecodeSchedulerOwner = {
	readonly queue: Set<ScheduledDecode>
	ready: boolean
	active: boolean
}

/**
 * Bounds native decoders independently from their caller-facing abort promises. A native decode
 * that cannot be cancelled keeps its execution slot until the held work actually settles.
 */
export class DecodeScheduler {
	private readonly readyOwners: DecodeSchedulerOwner[] = []
	private readonly owners = new Set<DecodeSchedulerOwner>()
	private readonly activeCompletions = new Set<Promise<void>>()
	private activeDecodes = 0
	private queuedDecodes = 0
	private active = true

	constructor(
		private readonly maxConcurrent: number,
		private readonly maxQueued: number,
		private readonly maxQueuedPerOwner: number,
	) {}

	createOwner(): DecodeSchedulerOwner {
		if (!this.active) throw new CanvasError('NOT_RUNNING', 'Canvas decode scheduler is stopped')
		const owner: DecodeSchedulerOwner = { queue: new Set(), ready: false, active: true }
		this.owners.add(owner)
		return owner
	}

	run<T>(
		owner: DecodeSchedulerOwner,
		signal: AbortSignal,
		task: (hold: (work: Promise<unknown>) => void) => Promise<T>,
	): Promise<T> {
		if (!this.active || !owner.active) {
			return Promise.reject(new CanvasError('NOT_RUNNING', 'Canvas decode owner is stopped'))
		}
		if (signal.aborted) return Promise.reject(abortReason(signal))

		return new Promise<T>((resolve, reject) => {
			let decode!: ScheduledDecode
			const settle = (callback: () => void) => {
				if (decode.state === 'settled') return
				decode.state = 'settled'
				signal.removeEventListener('abort', decode.onAbort)
				callback()
			}
			decode = {
				state: 'queued',
				owner,
				signal,
				onAbort: () => this.cancelQueued(decode, abortReason(signal)),
				start: () => {
					if (decode.state !== 'queued') return
					decode.state = 'running'
					signal.removeEventListener('abort', decode.onAbort)
					this.activeDecodes += 1
					const held: Promise<unknown>[] = []
					const execution = Promise.resolve().then(() =>
						task((work) => {
							held.push(work)
						}),
					)
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
						.then(() => Promise.allSettled(held))
						.then((): void => undefined)
						.finally((): void => {
							this.activeCompletions.delete(completion)
							this.activeDecodes -= 1
							this.dispatch()
						})
					this.activeCompletions.add(completion)
				},
				reject: (reason) => settle(() => reject(reason)),
			}

			if (this.activeDecodes < this.maxConcurrent) {
				decode.start()
				return
			}
			if (this.queuedDecodes >= this.maxQueued) {
				decode.reject(new CanvasError('DECODE_BUSY', 'Canvas decode queue is full'))
				return
			}
			if (owner.queue.size >= this.maxQueuedPerOwner) {
				decode.reject(new CanvasError('DECODE_BUSY', 'Caller Canvas decode queue is full'))
				return
			}
			signal.addEventListener('abort', decode.onAbort, { once: true })
			owner.queue.add(decode)
			this.queuedDecodes += 1
			this.enqueueOwner(owner)
		})
	}

	closeOwner(owner: DecodeSchedulerOwner, reason: Error): void {
		if (!owner.active) return
		owner.active = false
		this.owners.delete(owner)
		this.removeReadyOwner(owner)
		for (const decode of owner.queue) this.cancelQueued(decode, reason)
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
		while (this.active && this.activeDecodes < this.maxConcurrent) {
			const owner = this.readyOwners.shift()
			if (!owner) return
			owner.ready = false
			if (!owner.active) continue
			const decode = owner.queue.values().next().value as ScheduledDecode | undefined
			if (!decode) continue
			owner.queue.delete(decode)
			this.queuedDecodes -= 1
			if (owner.queue.size > 0) this.enqueueOwner(owner)
			decode.start()
		}
	}

	private cancelQueued(decode: ScheduledDecode, reason: Error): void {
		if (decode.state !== 'queued' || !decode.owner.queue.delete(decode)) return
		this.queuedDecodes -= 1
		if (decode.owner.queue.size === 0) this.removeReadyOwner(decode.owner)
		decode.reject(reason)
	}

	private enqueueOwner(owner: DecodeSchedulerOwner): void {
		if (!owner.active || owner.ready || owner.queue.size === 0) return
		owner.ready = true
		this.readyOwners.push(owner)
	}

	private removeReadyOwner(owner: DecodeSchedulerOwner): void {
		if (!owner.ready) return
		owner.ready = false
		const index = this.readyOwners.indexOf(owner)
		if (index >= 0) this.readyOwners.splice(index, 1)
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException('Canvas image decode aborted', 'AbortError')
}

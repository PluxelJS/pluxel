export type OutboundHttpErrorCode =
	| 'origin_denied'
	| 'redirect_denied'
	| 'management_disabled'
	| 'queue_full'
	| 'dispatcher_conflict'
	| 'revision_conflict'

export class OutboundHttpError extends Error {
	override readonly name = 'OutboundHttpError'

	constructor(
		readonly code: OutboundHttpErrorCode,
		message: string,
	) {
		super(message)
	}
}

// A queued observer can cancel while its producer is still busy. Re-arm the signal in the
// producer's own continuation so the next observer still has a live cross-event dependency.
class AdmissionSignal {
	private open = true
	private notification = Promise.withResolvers<void>()
	changed = this.listen()

	private async listen(): Promise<void> {
		await this.notification.promise
		if (this.open) {
			this.notification = Promise.withResolvers<void>()
			this.changed = this.listen()
		}
	}

	wake(): void {
		this.notification.resolve()
	}

	finish(): void {
		this.open = false
		this.wake()
	}
}

/** Wait for one Host-wide attempt slot. The supplied signal includes Host shutdown. */
export class RequestAdmission {
	private active = 0
	private full?: AdmissionSignal
	private readonly pending: AdmissionSignal[] = []
	private readonly release = () => {
		this.active--
		this.full?.finish()
		this.full = undefined
	}

	constructor(
		private readonly concurrent: number,
		private readonly queued: number,
	) {}

	acquire(signal: AbortSignal): (() => void) | Promise<() => void> {
		signal.throwIfAborted()
		const free = this.concurrent - this.active
		if (free > 0 && this.pending.length === 0) return this.admit()
		// Released slots already belong to the oldest waiters, even before their continuations run.
		if (this.pending.length >= this.queued + free)
			throw new OutboundHttpError('queue_full', 'Outbound HTTP request queue is full')
		return this.wait(signal)
	}

	private async wait(signal: AbortSignal): Promise<() => void> {
		const turn = new AdmissionSignal()
		let blocker = this.pending.at(-1) ?? this.full
		this.pending.push(turn)
		const depart = () => {
			const index = this.pending.indexOf(turn)
			if (index >= 0) this.pending.splice(index, 1)
			turn.finish()
		}
		const cancel = () => {
			depart()
			blocker?.wake()
		}
		signal.addEventListener('abort', cancel, { once: true })
		try {
			// Each waiter follows its predecessor's own completion. Cancellation in the middle
			// of the queue reconnects its successor to the nearest remaining predecessor.
			while (blocker) {
				await blocker.changed
				signal.throwIfAborted()
				blocker = this.pending[this.pending.indexOf(turn) - 1] ?? this.full
			}
			return this.admit()
		} finally {
			signal.removeEventListener('abort', cancel)
			if (!signal.aborted) depart()
		}
	}

	private admit(): () => void {
		this.active++
		// In workerd the promise a queued event awaits must belong to a live producer.
		// The request taking the last slot stays live until at least one slot is released.
		if (this.active === this.concurrent && this.queued) this.full = new AdmissionSignal()
		return this.release
	}
}

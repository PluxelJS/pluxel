export type OutboundHttpErrorCode =
	| 'origin_denied'
	| 'redirect_denied'
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

type Pending = {
	signal: AbortSignal
	resolve(release: () => void): void
	cancel(): void
}

/** Wait for one Host-wide attempt slot. The supplied signal includes Host shutdown. */
export class RequestAdmission {
	private active = 0
	private readonly pending: Pending[] = []

	constructor(
		private readonly concurrent: number,
		private readonly queued: number,
	) {}

	async acquire(signal: AbortSignal): Promise<() => void> {
		signal.throwIfAborted()
		if (this.active < this.concurrent) return this.admit()
		if (this.pending.length >= this.queued)
			throw new OutboundHttpError('queue_full', 'Outbound HTTP request queue is full')
		return new Promise((resolve, reject) => {
			const entry: Pending = {
				signal,
				resolve,
				cancel: () => {
					const index = this.pending.indexOf(entry)
					if (index >= 0) this.pending.splice(index, 1)
					reject(signal.reason)
				},
			}
			this.pending.push(entry)
			signal.addEventListener('abort', entry.cancel, { once: true })
		})
	}

	private admit(): () => void {
		this.active++
		return () => {
			this.active--
			const next = this.pending.shift()
			if (!next) return
			next.signal.removeEventListener('abort', next.cancel)
			next.resolve(this.admit())
		}
	}
}

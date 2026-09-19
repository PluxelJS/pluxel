import { DevConsoleError } from './contracts'

/** Run-owned admission and pending operations; application state remains host-owned. */
export class DevScope {
	readonly controller = new AbortController()
	private readonly pending = new Set<Promise<unknown>>()
	private disposal?: Promise<void>
	constructor(private readonly external?: AbortSignal) {
		external?.addEventListener('abort', this.abort, { once: true })
		if (external?.aborted) this.abort()
	}
	assertOpen(): void {
		if (this.controller.signal.aborted)
			throw new DevConsoleError('scope_closed', 'Development run is closing or closed')
	}
	run<T>(work: () => Promise<T> | T): Promise<T> {
		try {
			this.assertOpen()
		} catch (error) {
			return Promise.reject(error)
		}
		const promise = Promise.resolve().then(() => {
			this.assertOpen()
			return work()
		})
		this.pending.add(promise)
		void promise.then(
			() => this.pending.delete(promise),
			() => this.pending.delete(promise),
		)
		return promise
	}
	readonly abort = (): void => {
		if (!this.controller.signal.aborted) this.controller.abort(this.external?.reason)
	}
	dispose(): Promise<void> {
		if (this.disposal) return this.disposal
		this.abort()
		this.external?.removeEventListener('abort', this.abort)
		this.disposal = (async () => {
			const settled = await Promise.allSettled(this.pending)
			const errors = settled.flatMap((result) =>
				result.status === 'rejected' ? [result.reason] : [],
			)
			if (errors.length > 0) throw new AggregateError(errors, 'Development run operations failed')
		})()
		return this.disposal
	}
}

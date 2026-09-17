import { DevConsoleError } from './contracts'

/** Run-owned admission and resource tracking; application state remains host-owned. */
export class DevScope {
	readonly controller = new AbortController()
	private readonly pending = new Set<Promise<unknown>>()
	private readonly resources = new Set<() => void>()
	private readonly cleaning = new Set<Promise<void>>()
	private readonly errors: unknown[] = []
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
	own(cleanup: () => void | Promise<void>): () => void {
		let active = true
		const release = () => {
			if (!active) return
			active = false
			this.resources.delete(release)
			const task = cleanup()
			if (task) {
				const observed = Promise.resolve(task).catch((error: unknown): void => {
					this.errors.push(error)
				})
				this.cleaning.add(observed)
				void observed.then(() => this.cleaning.delete(observed))
			}
		}
		this.resources.add(release)
		if (this.controller.signal.aborted) release()
		return release
	}
	readonly abort = (): void => {
		if (!this.controller.signal.aborted) this.controller.abort(this.external?.reason)
		for (const release of [...this.resources].toReversed()) {
			try {
				release()
			} catch (error) {
				this.errors.push(error)
			}
		}
	}
	dispose(): Promise<void> {
		if (this.disposal) return this.disposal
		this.abort()
		this.external?.removeEventListener('abort', this.abort)
		this.disposal = (async () => {
			const settled = await Promise.allSettled(this.pending)
			for (const result of settled)
				if (result.status === 'rejected') this.errors.push(result.reason)
			this.abort()
			await Promise.all(this.cleaning)
			if (this.errors.length > 0)
				throw new AggregateError(this.errors, 'Development run resource cleanup failed')
		})()
		return this.disposal
	}
}

import { RpcStub, RpcTarget } from 'capnweb'

export type WorkbenchWatchOptions = Readonly<{
	/** Borrowed RPC callback. The watch retains and releases its own reference. */
	observer: (revision: number) => void | Promise<void>
	/** The current open's signal. An already closed open cannot subscribe. */
	signal: AbortSignal
	/** Register a local latest-state invalidation source; its returned registration is owned by the watch. */
	subscribe(notify: (revision: number) => void): Disposable
}>

/**
 * Bridge a local revision notification source to an owned RPC subscription.
 * At most one callback is in flight; intermediate notifications are replaced by the latest.
 * This is an invalidation watch, not a lossless event stream or a source of initial snapshots.
 */
export function createWorkbenchWatch(options: WorkbenchWatchOptions): RpcTarget {
	return new WorkbenchWatch(options)
}

class WorkbenchWatch extends RpcTarget {
	readonly #observer: RpcStub<WorkbenchWatchOptions['observer']>
	readonly #signal: AbortSignal
	#subscription?: Disposable
	#active = true
	#draining = false
	#pending?: number
	readonly #onAbort = () => this[Symbol.dispose]()

	constructor({ observer, signal, subscribe }: WorkbenchWatchOptions) {
		super()
		signal.throwIfAborted()
		if (!(observer instanceof RpcStub) || typeof observer !== 'function') {
			throw new TypeError('Workbench watch observer must be a Cap’n Web callback')
		}
		this.#observer = (observer as RpcStub<WorkbenchWatchOptions['observer']>).dup()
		this.#signal = signal
		signal.addEventListener('abort', this.#onAbort, { once: true })
		try {
			const subscription = subscribe((revision) => {
				if (!this.#active) return
				this.#pending = revision
				if (!this.#draining) void this.#drain()
			})
			if (!subscription || typeof subscription[Symbol.dispose] !== 'function') {
				throw new TypeError('Workbench watch subscribe must return a Disposable')
			}
			if (this.#active) this.#subscription = subscription
			else subscription[Symbol.dispose]()
		} catch (error) {
			try {
				this[Symbol.dispose]()
			} catch {
				// Preserve the registration failure; disposal still releases the callback in finally.
			}
			throw error
		}
	}

	[Symbol.dispose](): void {
		if (!this.#active) return
		this.#active = false
		this.#pending = undefined
		this.#signal.removeEventListener('abort', this.#onAbort)
		try {
			this.#subscription?.[Symbol.dispose]()
		} finally {
			this.#subscription = undefined
			this.#observer[Symbol.dispose]()
		}
	}

	async #drain(): Promise<void> {
		this.#draining = true
		try {
			while (this.#active && this.#pending !== undefined) {
				const revision = this.#pending
				this.#pending = undefined
				using invocation = this.#observer(revision)
				await invocation
			}
		} catch {
			try {
				this[Symbol.dispose]()
			} catch {
				// Failed observers terminate the watch; no rejected background task escapes.
			}
		} finally {
			this.#draining = false
		}
	}
}

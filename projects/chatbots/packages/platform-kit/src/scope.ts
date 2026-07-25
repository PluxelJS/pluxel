export type AbortLease = {
	readonly signal: AbortSignal
	current(): boolean
	throwIfStale(): void
}

/** Owns one replaceable async generation and makes stale completion checks explicit. */
export class SupersedingAbortScope {
	private controller?: AbortController

	renew(): AbortLease {
		this.abort(new Error('Superseded by a newer operation'))
		const controller = new AbortController()
		this.controller = controller
		return {
			signal: controller.signal,
			current: () => this.controller === controller && !controller.signal.aborted,
			throwIfStale: () => {
				if (this.controller !== controller || controller.signal.aborted)
					throw controller.signal.reason ?? new Error('Operation is no longer current')
			},
		}
	}

	abort(reason: unknown = new Error('Operation stopped')): void {
		this.controller?.abort(reason)
		this.controller = undefined
	}
}

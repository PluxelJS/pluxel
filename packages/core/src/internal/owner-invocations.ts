import type { Context } from '@pluxel/context'

export type OwnerInvocationLease = {
	readonly signal: AbortSignal
	dispose(): void
}

class OwnerInvocationGate {
	private readonly lifetime = new AbortController()
	private active = 0
	private idle?: {
		promise: Promise<void>
		resolve(value?: void | PromiseLike<void>): void
		reject(reason?: unknown): void
	}

	enter(callSignal?: AbortSignal): OwnerInvocationLease {
		if (this.lifetime.signal.aborted) throw abortReason(this.lifetime.signal)
		if (callSignal?.aborted) throw abortReason(callSignal)

		this.active += 1
		const signal = callSignal
			? callSignal === this.lifetime.signal
				? callSignal
				: AbortSignal.any([callSignal, this.lifetime.signal])
			: this.lifetime.signal
		let active = true
		return Object.freeze({
			signal,
			dispose: () => {
				if (!active) return
				active = false
				this.active -= 1
				if (this.active === 0) this.idle?.resolve()
			},
		})
	}

	close(reason?: unknown): void | Promise<void> {
		if (!this.lifetime.signal.aborted) {
			this.lifetime.abort(reason === undefined ? new Error('Plugin owner stopped') : reason)
		}
		if (this.active === 0) return
		this.idle ??= Promise.withResolvers<void>()
		return this.idle.promise
	}
}

const ownerInvocations = new WeakMap<Context, OwnerInvocationGate>()
const closedOwners = new WeakMap<Context, unknown>()
const DEFAULT_CLOSE_REASON = Symbol('default owner invocation close reason')

/** @internal Enter one owner generation call boundary. */
export function enterOwnerInvocation(
	owner: Context,
	callSignal?: AbortSignal,
): OwnerInvocationLease {
	let gate = ownerInvocations.get(owner)
	if (!gate) {
		const closedReason = closedOwners.get(owner)
		if (closedReason !== undefined) {
			throw closedReason === DEFAULT_CLOSE_REASON ? new Error('Plugin owner stopped') : closedReason
		}
		gate = new OwnerInvocationGate()
		ownerInvocations.set(owner, gate)
	}
	return gate.enter(callSignal)
}

/** @internal Stop admission, cancel active calls, and wait until their leases are released. */
export function closeOwnerInvocations(owner: Context, reason?: unknown): void | Promise<void> {
	const gate = ownerInvocations.get(owner)
	if (gate) return gate.close(reason)
	closedOwners.set(owner, reason === undefined ? DEFAULT_CLOSE_REASON : reason)
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

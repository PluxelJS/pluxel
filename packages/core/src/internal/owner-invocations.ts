import type { Context } from '../context/Context'

export type OwnerInvocationLease = {
	readonly signal: AbortSignal
	dispose(): void
}

/**
 * Internal zero-allocation token for callers that only need owner admission and drain tracking.
 * The gate itself is shared; every successful admission must have exactly one matching release.
 */
export type OwnerInvocationAdmission = OwnerInvocationGate

class OwnerInvocationGate {
	private readonly lifetime = new AbortController()
	private active = 0
	private idle?: {
		promise: Promise<void>
		resolve(value?: void | PromiseLike<void>): void
		reject(reason?: unknown): void
	}

	assertOpen(callSignal?: AbortSignal): void {
		if (this.lifetime.signal.aborted) throw abortReason(this.lifetime.signal)
		if (callSignal?.aborted) throw abortReason(callSignal)
	}

	admit(): OwnerInvocationAdmission {
		this.assertOpen()
		this.active += 1
		return this
	}

	release(): void {
		if (this.active === 0) {
			throw new Error('[pluxel/core] Owner invocation admission released without a match')
		}
		this.active -= 1
		if (this.active === 0) this.idle?.resolve()
	}

	enter(callSignal?: AbortSignal): OwnerInvocationLease {
		this.assertOpen(callSignal)

		this.active += 1
		const signal = callSignal
			? callSignal === this.lifetime.signal
				? callSignal
				: AbortSignal.any([callSignal, this.lifetime.signal])
			: this.lifetime.signal
		return new OwnerInvocationLeaseImpl(signal, this)
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

class OwnerInvocationLeaseImpl implements OwnerInvocationLease {
	private active = true

	constructor(
		readonly signal: AbortSignal,
		private readonly gate: OwnerInvocationGate,
	) {}

	dispose(): void {
		if (!this.active) return
		this.active = false
		this.gate.release()
	}
}

const ownerInvocations = new WeakMap<Context, OwnerInvocationGate>()
const closedOwners = new WeakMap<Context, unknown>()
const DEFAULT_CLOSE_REASON = Symbol('default owner invocation close reason')

function assertOwnerNotClosed(owner: Context): void {
	const gate = ownerInvocations.get(owner)
	if (gate) {
		gate.assertOpen()
		return
	}
	const closedReason = closedOwners.get(owner)
	if (closedReason !== undefined) {
		throw closedReason === DEFAULT_CLOSE_REASON ? new Error('Plugin owner stopped') : closedReason
	}
}

function requireOwnerInvocationGate(owner: Context): OwnerInvocationGate {
	let gate = ownerInvocations.get(owner)
	if (gate) return gate
	assertOwnerNotClosed(owner)
	gate = new OwnerInvocationGate()
	ownerInvocations.set(owner, gate)
	return gate
}

/** @internal Reject stale access without retaining a drain lease. */
export function assertOwnerInvocationOpen(owner: Context): void {
	assertOwnerNotClosed(owner)
}

/** @internal Admit one owner call without allocating a per-call lease object. */
export function admitOwnerInvocation(owner: Context): OwnerInvocationAdmission {
	return requireOwnerInvocationGate(owner).admit()
}

/** @internal Release one admission obtained from `admitOwnerInvocation`. */
export function releaseOwnerInvocation(admission: OwnerInvocationAdmission): void {
	admission.release()
}

/** @internal Enter one owner generation call boundary. */
export function enterOwnerInvocation(
	owner: Context,
	callSignal?: AbortSignal,
): OwnerInvocationLease {
	return requireOwnerInvocationGate(owner).enter(callSignal)
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

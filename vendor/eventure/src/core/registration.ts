import type { ListenerPosition, Unsubscribe } from '../types'

const SYMBOL_DISPOSE: symbol | undefined = (Symbol as any).dispose

export const POS_BACK = 0
export const POS_FRONT = 1
export const POS_INDEX = 2
export const POS_RESOLVE = 3
export type PositionKind =
	| typeof POS_BACK
	| typeof POS_FRONT
	| typeof POS_INDEX
	| typeof POS_RESOLVE
export type EncodedPosition<Ctx> = [PositionKind, number | ((ctx: Ctx) => number)]

export function encodeListenerPosition<Ctx>(position: ListenerPosition<Ctx>): EncodedPosition<Ctx> {
	switch (position) {
		case 'front':
			return [POS_FRONT, 0]
		case 'back':
			return [POS_BACK, 0]
		default:
			return typeof position === 'function' ? [POS_RESOLVE, position] : [POS_INDEX, position]
	}
}

export function resolveInsertIndex<Ctx>(
	count: number,
	at: number | ((ctx: Ctx) => number),
	ctx?: Ctx,
): number {
	const raw = typeof at === 'function' ? at(ctx as Ctx) : at
	if (typeof raw !== 'number' || !Number.isFinite(raw)) return count
	return Math.min(count, Math.max(0, Math.trunc(raw)))
}

export function normalizeMaxListeners(count: number): number {
	if (count !== Number.POSITIVE_INFINITY && (!Number.isInteger(count) || count < 0)) {
		throw new RangeError('maxListeners must be a non-negative integer or Infinity')
	}
	return count
}

export function attachDispose<T extends Unsubscribe>(unsub: T): T {
	if (SYMBOL_DISPOSE) (unsub as any)[SYMBOL_DISPOSE] = unsub
	return unsub
}

export const noopSubscription: Unsubscribe = attachDispose((() => {}) as Unsubscribe)

const subscriptions = new WeakMap<Unsubscribe, Subscription>()

/** One removable occurrence, independent of the listener function's identity. */
export class Subscription {
	readonly unsubscribe: Unsubscribe = attachDispose(() => this.remove?.(this))
	private observers?: (() => void)[]

	constructor(
		private remove?: (subscription: Subscription) => void,
		private signal?: AbortSignal,
	) {
		subscriptions.set(this.unsubscribe, this)
		signal?.addEventListener('abort', this.unsubscribe, { once: true })
	}

	observeEnd(observer: () => void): void {
		if (!this.remove) observer()
		else (this.observers ??= []).push(observer)
	}

	end(): void {
		this.remove = undefined
		this.signal?.removeEventListener('abort', this.unsubscribe)
		this.signal = undefined
		const observers = this.observers
		this.observers = undefined
		if (observers) for (const observer of observers) observer()
	}
}

/** @internal Used by owners to release their cleanup registration when the work ends. */
export function observeSubscriptionEnd(unsubscribe: Unsubscribe, observer: () => void): void {
	if (unsubscribe === noopSubscription) observer()
	else subscriptions.get(unsubscribe)?.observeEnd(observer)
}

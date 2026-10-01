import { encodeListenerPosition, type PositionKind } from './core/registration'
import {
	combineGuardPredicate,
	type GuardPredicate,
	normalizeTimes,
} from './ext/limitSingle'
import type {
	EventListener,
	IEventMap,
	SubscriptionOptions,
	ListenerPosition,
	Unsubscribe,
} from './types'

export type EventurePosition<
	E extends IEventMap<E>,
	K extends keyof E,
> = ListenerPosition<{ count: number; event: K }>

export interface EventureScope<E extends IEventMap<E>, K extends keyof E> {
	on(listener: EventListener<E[K]>, options?: SubscriptionOptions): Unsubscribe
	once(
		listener: EventListener<E[K]>,
		options?: SubscriptionOptions,
	): Unsubscribe
	many(
		times: number,
		listener: EventListener<E[K]>,
		options?: SubscriptionOptions,
	): Unsubscribe
	when(predicate: GuardPredicate<E[K]>): EventureScope<E, K>
	at(position: EventurePosition<E, K>): EventureScope<E, K>
}

export type EventureScopeAdd<E extends IEventMap<E>, K extends keyof E> = (
	listener: EventListener<E[K]>,
	times: number,
	posKind: PositionKind,
	posValue: number | ((ctx: { count: number; event: K }) => number),
	predicate?: GuardPredicate<E[K]>,
	signal?: AbortSignal,
) => Unsubscribe

export class EventureListenerScope<
	E extends IEventMap<E>,
	K extends keyof E,
> implements EventureScope<E, K> {
	constructor(
		private readonly add: EventureScopeAdd<E, K>,
		private readonly posKind: PositionKind,
		private readonly posValue:
			| number
			| ((ctx: { count: number; event: K }) => number),
		private readonly predicate: GuardPredicate<E[K]> | undefined,
	) {}

	public on(
		listener: EventListener<E[K]>,
		options?: SubscriptionOptions,
	): Unsubscribe {
		return this.add(
			listener,
			0,
			this.posKind,
			this.posValue,
			this.predicate,
			options?.signal,
		)
	}

	public once(
		listener: EventListener<E[K]>,
		options?: SubscriptionOptions,
	): Unsubscribe {
		return this.add(
			listener,
			1,
			this.posKind,
			this.posValue,
			this.predicate,
			options?.signal,
		)
	}

	public many(
		times: number,
		listener: EventListener<E[K]>,
		options?: SubscriptionOptions,
	): Unsubscribe {
		normalizeTimes(times)
		return this.add(
			listener,
			times,
			this.posKind,
			this.posValue,
			this.predicate,
			options?.signal,
		)
	}

	public when(predicate: GuardPredicate<E[K]>): EventureScope<E, K> {
		return new EventureListenerScope(
			this.add,
			this.posKind,
			this.posValue,
			combineGuardPredicate(this.predicate, predicate),
		)
	}

	public at(position: EventurePosition<E, K>): EventureScope<E, K> {
		const [posKind, posValue] = encodeListenerPosition(position)
		return new EventureListenerScope(
			this.add,
			posKind,
			posValue,
			this.predicate,
		)
	}
}

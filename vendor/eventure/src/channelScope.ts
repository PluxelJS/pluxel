import { encodeListenerPosition, type PositionKind } from './core/registration'
import {
	combineGuardPredicate,
	type GuardPredicate,
	normalizeTimes,
} from './ext/limitSingle'
import type {
	EventDescriptor,
	EventListener,
	SubscriptionOptions,
	ListenerPosition,
	Unsubscribe,
} from './types'

export type EvtChannelPosition = ListenerPosition<{ count: number }>

export interface EvtChannelScope<D extends EventDescriptor> {
	on(listener: EventListener<D>, options?: SubscriptionOptions): Unsubscribe
	once(listener: EventListener<D>, options?: SubscriptionOptions): Unsubscribe
	many(
		times: number,
		listener: EventListener<D>,
		options?: SubscriptionOptions,
	): Unsubscribe
	when(predicate: GuardPredicate<D>): EvtChannelScope<D>
	at(position: EvtChannelPosition): EvtChannelScope<D>
}

export type EvtChannelScopeAdd<D extends EventDescriptor> = (
	listener: EventListener<D>,
	times: number,
	posKind: PositionKind,
	posValue: number | ((ctx: { count: number }) => number),
	predicate?: GuardPredicate<D>,
	signal?: AbortSignal,
) => Unsubscribe

export class ChannelListenerScope<
	D extends EventDescriptor,
> implements EvtChannelScope<D> {
	constructor(
		private readonly add: EvtChannelScopeAdd<D>,
		private readonly posKind: PositionKind,
		private readonly posValue: number | ((ctx: { count: number }) => number),
		private readonly predicate: GuardPredicate<D> | undefined,
	) {}

	public on(
		listener: EventListener<D>,
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
		listener: EventListener<D>,
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
		listener: EventListener<D>,
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

	public when(predicate: GuardPredicate<D>): EvtChannelScope<D> {
		return new ChannelListenerScope(
			this.add,
			this.posKind,
			this.posValue,
			combineGuardPredicate(this.predicate, predicate),
		)
	}

	public at(position: EvtChannelPosition): EvtChannelScope<D> {
		const [posKind, posValue] = encodeListenerPosition(position)
		return new ChannelListenerScope(this.add, posKind, posValue, this.predicate)
	}
}

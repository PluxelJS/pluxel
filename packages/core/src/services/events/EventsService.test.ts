import { LoggerService } from '../../logger/LoggerService'
import { EffectsService } from '../effects/EffectsService'
import { describe, expect, it } from 'vitest'
import {
	BasePlugin,
	EvtChannel,
	Plugin,
	type CoreHostConfig,
	type Events,
	EventsService,
} from '@pluxel/core'
import { resolveCoreRootInputs } from '@pluxel/core/internal'
import { withCoreInternalTestHost } from '@pluxel/core/internal/test'

declare module '@pluxel/core' {
	interface Events {
		'test:ambient-changed': [value: string]
	}
}

const ambientHostConfig = {
	events: {
		events: ['test:ambient-changed'],
		errorPolicy: 'throw',
	},
} satisfies CoreHostConfig

@Plugin({ displayName: 'Channel owner' })
class ChannelOwner extends BasePlugin {
	readonly changed = new EvtChannel<[value: string]>(this.ctx)

	listenAmbient(seen: string[]) {
		this.ctx.service(EventsService).on('test:ambient-changed', (value) => seen.push(value))
	}
}

@Plugin({ displayName: 'Channel consumer' })
class ChannelConsumer extends BasePlugin {
	readonly seen: string[] = []
	readonly seenOnce: string[] = []
	readonly seenAt: string[] = []
	readonly seenFront: string[] = []
	readonly seenAmbient: string[] = []
	boundChannel?: EvtChannel<[value: string]>
	constructor(private readonly owner: ChannelOwner) {
		super()
	}
	override init() {
		this.boundChannel = this.owner.changed
		this.boundChannel.on((value) => this.seen.push(value))
		this.boundChannel.when().once((value) => this.seenOnce.push(value))
		this.boundChannel.onAt({ at: 0 }, (value) => this.seenAt.push(value))
		this.boundChannel.onFront((value) => this.seenFront.push(value))
		this.owner.listenAmbient(this.seenAmbient)
	}
}

@Plugin({ displayName: 'Ambient listener' })
class AmbientListener extends BasePlugin {
	readonly seen: string[] = []
	readonly seenOnce: string[] = []
	readonly seenAt: string[] = []
	boundEvents?: EventsService

	override init() {
		this.boundEvents = this.ctx.service(EventsService)
		this.ctx.service(EventsService).on('test:ambient-changed', (value) => this.seen.push(value))
		this.ctx
			.service(EventsService)
			.when('test:ambient-changed')
			.once((value) => this.seenOnce.push(value))
		this.ctx
			.service(EventsService)
			.onAt('test:ambient-changed', { at: 0 }, (value) => this.seenAt.push(value))
	}
}

describe('event boundaries', () => {
	it('keeps named channels and owner-scoped subscriptions', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([ChannelOwner, ChannelConsumer])
			await host.commit()
			const owner = host.require(ChannelOwner)
			const consumer = host.require(ChannelConsumer)
			expect(() => {
				;(owner.ctx.service(EffectsService) as unknown as { ctx: unknown }).ctx = consumer.ctx
			}).toThrow(TypeError)
			expect(() => {
				;(owner.ctx.service(LoggerService) as unknown as { ctx: unknown }).ctx = consumer.ctx
			}).toThrow(TypeError)
			expect(Object.isExtensible(consumer.boundChannel!)).toBe(false)
			expect(consumer.boundChannel!.ctx).toBe(owner.ctx)
			expect(() => {
				;(consumer.boundChannel as { ctx: unknown }).ctx = consumer.ctx
			}).toThrow(TypeError)
			expect(Object.getOwnPropertyDescriptor(consumer.boundChannel!, 'on')).toMatchObject({
				configurable: false,
			})
			owner.changed.emit('a')
			owner.ctx.service(EventsService).emit('test:ambient-changed', 'ambient-a')
			expect(consumer.seen).toEqual(['a'])
			expect(consumer.seenOnce).toEqual(['a'])
			expect(consumer.seenAt).toEqual(['a'])
			expect(consumer.seenFront).toEqual(['a'])
			expect(consumer.seenAmbient).toEqual(['ambient-a'])
			host.remove(ChannelConsumer)
			await host.commit()
			const listenerCount = owner.changed.count()
			expect(() => consumer.boundChannel!.on(() => undefined)).toThrow(/disposed/i)
			expect(() => consumer.boundChannel!.when().once(() => undefined)).toThrow(/disposed/i)
			expect(owner.changed.count()).toBe(listenerCount)
			owner.changed.emit('b')
			owner.ctx.service(EventsService).emit('test:ambient-changed', 'ambient-b')
			expect(consumer.seen).toEqual(['a'])
			expect(consumer.seenOnce).toEqual(['a'])
			expect(consumer.seenAt).toEqual(['a'])
			expect(consumer.seenFront).toEqual(['a'])
			expect(consumer.seenAmbient).toEqual(['ambient-a'])
		})
	})

	it('keeps augmented ambient events loose-coupled and owner-scoped', async () => {
		await withCoreInternalTestHost(async (host) => {
			expect(ambientHostConfig.events.events).toEqual(['test:ambient-changed'])
			const configuredEvents: (keyof Events)[] = ['test:ambient-changed']
			const inputs = resolveCoreRootInputs({
				events: { events: configuredEvents, errorPolicy: 'throw' },
			})
			configuredEvents.length = 0
			expect(inputs.events?.events).toEqual(['test:ambient-changed'])
			expect(Object.isFrozen(inputs.events)).toBe(true)
			expect(Object.isFrozen(inputs.events?.events)).toBe(true)

			host.add([ChannelOwner, AmbientListener])
			await host.commit()
			const publisher = host.require(ChannelOwner)
			const listener = host.require(AmbientListener)

			expect(host.ctx.service(EventsService)).not.toBe(publisher.ctx.service(EventsService))
			expect(host.ctx.service(EventsService).ctx).toBe(host.ctx)
			expect(listener.boundEvents).toBe(listener.ctx.service(EventsService))
			expect(listener.ctx.service(EventsService)).not.toBe(publisher.ctx.service(EventsService))
			expect(listener.ctx.service(EventsService).ctx).toBe(listener.ctx)
			expect(Object.isExtensible(listener.ctx.service(EventsService))).toBe(false)
			publisher.ctx.service(EventsService).emit('test:ambient-changed', 'a')
			expect(listener.seen).toEqual(['a'])
			expect(listener.seenOnce).toEqual(['a'])
			expect(listener.seenAt).toEqual(['a'])
			const manuallyRemoved: string[] = []
			const unsubscribe = listener.ctx
				.service(EventsService)
				.on('test:ambient-changed', (value) => manuallyRemoved.push(value))
			unsubscribe()
			publisher.ctx.service(EventsService).emit('test:ambient-changed', 'after-unsubscribe')
			expect(manuallyRemoved).toEqual([])

			const pending = listener.ctx.service(EventsService).waitFor('test:ambient-changed')
			const cancelled = pending.then(
				() => {
					throw new Error('waitFor should be cancelled when its owner stops')
				},
				(error: unknown) =>
					expect(error).toEqual(
						expect.objectContaining({ message: "waitFor 'test:ambient-changed' cancelled" }),
					),
			)

			host.remove(AmbientListener)
			await host.commit()
			await cancelled
			expect(() => listener.boundEvents!.on('test:ambient-changed', (): void => undefined)).toThrow(
				/disposed/i,
			)
			publisher.ctx.service(EventsService).emit('test:ambient-changed', 'b')
			expect(listener.seen).toEqual(['a', 'after-unsubscribe'])
			expect(listener.seenAt).toEqual(['a', 'after-unsubscribe'])
		})
	})
})

import { describe, expect, it } from 'vitest'
import {
	BasePlugin,
	EvtChannel,
	Plugin,
	type CoreHostConfig,
	type EventsService,
} from '@pluxel/core'
import { withCoreHost } from '@pluxel/core/test'

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
		this.ctx.events.on('test:ambient-changed', (value) => seen.push(value))
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
		this.boundEvents = this.ctx.events
		this.ctx.events.on('test:ambient-changed', (value) => this.seen.push(value))
		this.ctx.events.when('test:ambient-changed').once((value) => this.seenOnce.push(value))
		this.ctx.events.onAt('test:ambient-changed', { at: 0 }, (value) => this.seenAt.push(value))
	}
}

describe('event boundaries', () => {
	it('keeps named channels and owner-scoped subscriptions', async () => {
		await withCoreHost(async (host) => {
			host.add([ChannelOwner, ChannelConsumer])
			await host.commit()
			const owner = host.require(ChannelOwner)
			const consumer = host.require(ChannelConsumer)
			expect(() => {
				;(owner.ctx.effects as unknown as { ctx: unknown }).ctx = consumer.ctx
			}).toThrow(TypeError)
			expect(() => {
				;(owner.ctx.logger as unknown as { ctx: unknown }).ctx = consumer.ctx
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
			owner.ctx.events.emit('test:ambient-changed', 'ambient-a')
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
			owner.ctx.events.emit('test:ambient-changed', 'ambient-b')
			expect(consumer.seen).toEqual(['a'])
			expect(consumer.seenOnce).toEqual(['a'])
			expect(consumer.seenAt).toEqual(['a'])
			expect(consumer.seenFront).toEqual(['a'])
			expect(consumer.seenAmbient).toEqual(['ambient-a'])
		})
	})

	it('keeps augmented ambient events loose-coupled and owner-scoped', async () => {
		await withCoreHost(async (host) => {
			expect(ambientHostConfig.events.events).toEqual(['test:ambient-changed'])
			host.add([ChannelOwner, AmbientListener])
			await host.commit()
			const publisher = host.require(ChannelOwner)
			const listener = host.require(AmbientListener)

			expect(listener.boundEvents).toBe(listener.ctx.events)
			expect(listener.ctx.events).not.toBe(publisher.ctx.events)
			expect(listener.ctx.events.ctx).toBe(listener.ctx)
			expect(Object.isExtensible(listener.ctx.events)).toBe(false)
			publisher.ctx.events.emit('test:ambient-changed', 'a')
			expect(listener.seen).toEqual(['a'])
			expect(listener.seenOnce).toEqual(['a'])
			expect(listener.seenAt).toEqual(['a'])

			host.remove(AmbientListener)
			await host.commit()
			expect(() => listener.boundEvents!.on('test:ambient-changed', (): void => undefined)).toThrow(
				/disposed/i,
			)
			publisher.ctx.events.emit('test:ambient-changed', 'b')
			expect(listener.seen).toEqual(['a'])
			expect(listener.seenAt).toEqual(['a'])
		})
	})
})

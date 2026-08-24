import { describe, expect, it } from 'vitest'
import { BasePlugin, EvtChannel, Plugin } from '@pluxel/core'
import { withCoreHost } from '@pluxel/core/test'

@Plugin({ displayName: 'Channel owner' })
class ChannelOwner extends BasePlugin {
	readonly changed = new EvtChannel<[value: string]>(this.ctx)
}

@Plugin({ displayName: 'Channel consumer' })
class ChannelConsumer extends BasePlugin {
	readonly seen: string[] = []
	readonly seenOnce: string[] = []
	readonly seenAt: string[] = []
	readonly seenFront: string[] = []
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
			expect(consumer.seen).toEqual(['a'])
			expect(consumer.seenOnce).toEqual(['a'])
			expect(consumer.seenAt).toEqual(['a'])
			expect(consumer.seenFront).toEqual(['a'])
			host.remove(ChannelConsumer)
			await host.commit()
			const listenerCount = owner.changed.count()
			expect(() => consumer.boundChannel!.on(() => undefined)).toThrow(/disposed/i)
			expect(() => consumer.boundChannel!.when().once(() => undefined)).toThrow(/disposed/i)
			expect(owner.changed.count()).toBe(listenerCount)
			owner.changed.emit('b')
			expect(consumer.seen).toEqual(['a'])
			expect(consumer.seenOnce).toEqual(['a'])
			expect(consumer.seenAt).toEqual(['a'])
			expect(consumer.seenFront).toEqual(['a'])
		})
	})
})

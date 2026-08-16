import { describe, expect, it } from 'vitest'
import { BasePlugin, EvtChannel, Plugin } from '@pluxel/core'
import { withCoreHost } from '@pluxel/core/test'

@Plugin({ displayName: 'Channel owner' })
class ChannelOwner extends BasePlugin {
	readonly changed = new EvtChannel<[value: string]>(() => this.ctx)
}

@Plugin({ displayName: 'Channel consumer' })
class ChannelConsumer extends BasePlugin {
	readonly seen: string[] = []
	constructor(private readonly owner: ChannelOwner) {
		super()
	}
	override init() {
		this.owner.changed.on((value) => this.seen.push(value))
	}
}

describe('event boundaries', () => {
	it('keeps named channels and owner-scoped subscriptions', async () => {
		await withCoreHost(async (host) => {
			host.add([ChannelOwner, ChannelConsumer])
			await host.commit()
			const owner = host.require(ChannelOwner)
			const consumer = host.require(ChannelConsumer)
			owner.changed.emit('a')
			expect(consumer.seen).toEqual(['a'])
			host.remove(ChannelConsumer)
			await host.commit()
			owner.changed.emit('b')
			expect(consumer.seen).toEqual(['a'])
		})
	})
})

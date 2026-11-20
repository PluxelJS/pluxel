import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, withCoreInternalTestHost } from '@pluxel/core/internal/test'

@Plugin({ forkable: true })
class Forkable extends BasePlugin {}

@Plugin({ displayName: 'Fork consumer' })
class ForkConsumer extends BasePlugin {
	constructor(readonly dependency: Forkable) {
		super()
	}
}

@Plugin()
class NonForkable extends BasePlugin {}

describe('fork node identity', () => {
	it('rejects non-forkable Plugins', async () => {
		await withCoreInternalTestHost((host) => {
			expect(() => host.fork(NonForkable as never, 'a')).toThrow(/does not allow fork/i)
		})
	})

	it('selects a fork through slot-based dependency overrides', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.fork(Forkable, 'a')
			const B = host.fork(Forkable, 'b')
			host.add(ForkConsumer)
			host.override(ForkConsumer, Forkable, B)
			await host.commit()
			expect(host.require(ForkConsumer).dependency.ctx.pluginInfo.nodeAddress).toMatchObject({
				variant: 'fork',
				forkId: 'b',
			})
		})
	})
})

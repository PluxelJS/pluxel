import { describe, expect, it } from 'vitest'
import { BasePlugin, ForkablePlugin, Plugin, withCoreHost } from '@pluxel/core/test'

@Plugin()
class Forkable extends ForkablePlugin {}

@Plugin({ displayName: 'Fork consumer' })
class ForkConsumer extends BasePlugin {
	constructor(readonly dependency: Forkable) {
		super()
	}
}

describe('fork node identity', () => {
	it('rejects non-forkable Plugins', async () => {
		await withCoreHost((host) => {
			@Plugin()
			class Plain extends BasePlugin {}
			expect(() => host.fork(Plain as never, 'a')).toThrow(/is not forkable/)
		})
	})

	it('runs fork nodes with isolated Context and structured addresses', async () => {
		await withCoreHost(async (host) => {
			const A = host.fork(Forkable, 'a')
			const B = host.fork(Forkable, 'b')
			await host.commit()
			const a = host.require(A)
			const b = host.require(B)
			expect(a).not.toBe(b)
			expect(a.ctx).not.toBe(b.ctx)
			expect(a.ctx.pluginInfo.nodeAddress).toMatchObject({ instance: 'fork', forkId: 'a' })
			expect(b.ctx.pluginInfo.nodeAddress).toMatchObject({ instance: 'fork', forkId: 'b' })
		})
	})

	it('selects a fork through slot-based dependency overrides', async () => {
		await withCoreHost(async (host) => {
			host.fork(Forkable, 'a')
			const B = host.fork(Forkable, 'b')
			host.add(ForkConsumer)
			host.ctx.registry.replaceRuntimeDependencyOverrides(ForkConsumer, [B])
			await host.commit()
			expect(host.require(ForkConsumer).dependency.ctx.pluginInfo.nodeAddress).toMatchObject({
				instance: 'fork',
				forkId: 'b',
			})
		})
	})
})

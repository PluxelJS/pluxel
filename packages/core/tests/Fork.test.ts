import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, withCoreHost } from '@pluxel/core/test'

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
		await withCoreHost((host) => {
			expect(() => host.fork(NonForkable as never, 'a')).toThrow(/does not allow fork/i)
		})
	})

	it('runs fork nodes with isolated Context and structured addresses', async () => {
		await withCoreHost(async (host) => {
			host.add(Forkable)
			const A = host.fork(Forkable, 'a')
			const B = host.fork(Forkable, 'b')
			await host.commit()
			const defaultNode = host.require(Forkable)
			const a = host.require(A)
			const b = host.require(B)
			expect(a).not.toBe(b)
			expect(a.ctx).not.toBe(b.ctx)
			expect(defaultNode.constructor).toBe(Forkable)
			expect(a.constructor).toBe(Forkable)
			expect(b.constructor).toBe(Forkable)
			expect(a.ctx.pluginInfo.definitionRevision).toBe(
				defaultNode.ctx.pluginInfo.definitionRevision,
			)
			expect(b.ctx.pluginInfo.definitionRevision).toBe(
				defaultNode.ctx.pluginInfo.definitionRevision,
			)
			expect(a.ctx.pluginInfo.nodeAddress).toMatchObject({ variant: 'fork', forkId: 'a' })
			expect(b.ctx.pluginInfo.nodeAddress).toMatchObject({ variant: 'fork', forkId: 'b' })
		})
	})

	it('selects a fork through slot-based dependency overrides', async () => {
		await withCoreHost(async (host) => {
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

import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, withCoreHost } from '@pluxel/core/test'

@Plugin({ displayName: 'Cascade provider' })
class CascadeProvider extends BasePlugin {}

@Plugin({ displayName: 'Cascade consumer' })
class CascadeConsumer extends BasePlugin {
	constructor(readonly provider: CascadeProvider) {
		super()
	}
}

describe('required dependent closure', () => {
	it('restarts required dependents exactly once', async () => {
		await withCoreHost(async (host) => {
			host.add([CascadeProvider, CascadeConsumer])
			await host.commit()
			const firstProvider = host.require(CascadeProvider)
			const firstConsumer = host.require(CascadeConsumer)
			host.restart(CascadeProvider)
			const summary = await host.commit()
			expect(host.require(CascadeProvider)).not.toBe(firstProvider)
			expect(host.require(CascadeConsumer)).not.toBe(firstConsumer)
			expect(new Set(summary.pluginChanges.restarted)).toEqual(
				new Set([
					host.ctx.registry.resolvePluginNode(CascadeProvider),
					host.ctx.registry.resolvePluginNode(CascadeConsumer),
				]),
			)
		})
	})

	it('rejects a non-cascading removal that leaves a missing dependency', async () => {
		await withCoreHost(async (host) => {
			host.add([CascadeProvider, CascadeConsumer])
			await host.commit()
			host.ctx.registry.unregister(CascadeProvider, { cascadeDependents: false })
			await expect(host.commit()).rejects.toThrow(/service verification failed/)
			expect(host.isRunning(CascadeProvider)).toBe(true)
			expect(host.isRunning(CascadeConsumer)).toBe(true)
		})
	})
})

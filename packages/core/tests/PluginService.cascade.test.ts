import { describe, expect, it } from 'vitest'
import { CorePluginGraphVerificationError, requirePluginService } from '@pluxel/core/internal'
import { BasePlugin, Plugin } from '@pluxel/core/test'
import { withCoreInternalTestHost } from '@pluxel/core/internal/test'

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
		await withCoreInternalTestHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			host.add([CascadeProvider, CascadeConsumer])
			await host.commit()
			const firstProvider = host.require(CascadeProvider)
			const firstConsumer = host.require(CascadeConsumer)
			host.restart(CascadeProvider)
			const summary = await host.commit()
			expect(host.require(CascadeProvider)).not.toBe(firstProvider)
			const secondConsumer = host.require(CascadeConsumer)
			expect(secondConsumer === firstConsumer).toBe(false)
			expect(new Set(summary.pluginChanges.restarted)).toEqual(
				new Set([
					registry.resolvePluginNode(CascadeProvider),
					registry.resolvePluginNode(CascadeConsumer),
				]),
			)
		})
	})

	it('rejects a non-cascading removal that leaves a missing dependency', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([CascadeProvider, CascadeConsumer])
			await host.commit()
			host.remove(CascadeProvider, { cascadeDependents: false })
			const error = await Promise.resolve()
				.then(() => host.commit())
				.catch((cause: unknown) => cause)
			expect(error).toBeInstanceOf(CorePluginGraphVerificationError)
			if (!(error instanceof CorePluginGraphVerificationError)) throw error
			expect(error.message).toMatch(/Core Plugin graph verification failed/)
			expect(error.issues).toBe(error.cause.issues)
			expect(error.issues.some((issue) => issue.kind === 'MissingDependency')).toBe(true)
			expect(host.isRunning(CascadeProvider)).toBe(true)
			expect(host.isRunning(CascadeConsumer)).toBe(true)
		})
	})
})

import { describe, expect, it } from 'vitest'
import { requirePluginService } from '@pluxel/core/internal'
import {
	BasePlugin,
	Plugin,
	assertPluginLifecycleIssue,
	pluginLifecycleIssuePlugins,
	withCoreHost,
} from '@pluxel/core/test'

const teardownEvents: string[] = []

@Plugin({ displayName: 'Drain provider' })
class TeardownProvider extends BasePlugin {
	override init() {
		return () => {
			teardownEvents.push('provider')
		}
	}
}

@Plugin({ displayName: 'Drain consumer' })
class TeardownConsumer extends BasePlugin {
	constructor(_provider: TeardownProvider) {
		super()
	}
	override init() {
		return () => {
			teardownEvents.push('consumer')
		}
	}
}

@Plugin({ displayName: 'Drain failure' })
class DrainFailure extends BasePlugin {
	override init() {
		return () => {
			throw new Error('drain boom')
		}
	}
}

describe('effects-only generation teardown', () => {
	it('drains dependent effects before provider effects', async () => {
		await withCoreHost(async (host) => {
			teardownEvents.length = 0
			host.add([TeardownProvider, TeardownConsumer])
			await host.commit()
			host.remove(TeardownProvider)
			await host.commit()
			expect(teardownEvents).toEqual(['consumer', 'provider'])
		})
	})

	it('reports cleanup failures while continuing teardown', async () => {
		await withCoreHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			host.add(DrainFailure)
			await host.commit()
			host.remove(DrainFailure)
			const summary = await host.commitAllowFail()
			expect(pluginLifecycleIssuePlugins(summary)).toEqual([
				registry.internNodeAddress(host.cfg(DrainFailure).owner),
			])
			assertPluginLifecycleIssue(summary, DrainFailure, {
				phase: 'drain',
				kind: 'drain-failed',
				message: 'drain boom',
			})
		})
	})
})

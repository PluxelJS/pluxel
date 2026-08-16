import { describe, expect, it } from 'vitest'

import {
	BasePlugin,
	type CommitSummary,
	Plugin,
	assertPluginLifecycleIssue,
	pluginLifecycleIssuePlugins,
	withCoreHost,
} from '@pluxel/core/test'

@Plugin({ displayName: 'STRICT-FAIL-A' })
class StrictFailPlugin extends BasePlugin {
	override init(): void {
		throw new Error('boom')
	}
}

let independentStarted = 0

@Plugin({ displayName: 'FAIL-SUBTREE-A' })
class FailingProvider extends BasePlugin {
	override init(): void {
		throw new Error('boom')
	}
}

@Plugin({ displayName: 'FAIL-SUBTREE-B' })
class BlockedConsumer extends BasePlugin {
	constructor(_dep: FailingProvider) {
		super()
	}
}

@Plugin({ displayName: 'FAIL-SUBTREE-C' })
class IndependentPlugin extends BasePlugin {
	override init(): void {
		independentStarted++
	}
}

describe('PluginService failure reporting', () => {
	it('commitStrict publishes failure details through runtimeCommitted before returning an error', async () => {
		await withCoreHost(async (host) => {
			const committed: CommitSummary[] = []

			const unsubscribe = host.ctx.registry.subscribeCommitted((summary) => {
				committed.push(summary)
			})
			host.ctx.effects.defer(unsubscribe)

			host.add(StrictFailPlugin)
			const failed = await host.ctx.registry.commitStrict()

			// Strict mode still publishes commit-side observability before surfacing the error result.
			expect(failed.ok).toBe(false)
			expect(committed).toHaveLength(1)
			expect(pluginLifecycleIssuePlugins(committed[0]!)).toEqual([
				host.ctx.registry.resolvePluginNode(StrictFailPlugin),
			])
			expect(pluginLifecycleIssuePlugins(host.ctx.registry.lastCommit!)).toEqual([
				host.ctx.registry.resolvePluginNode(StrictFailPlugin),
			])
			assertPluginLifecycleIssue(host.ctx.registry.lastCommit!, StrictFailPlugin, {
				phase: 'start',
				kind: 'start-failed',
				message: 'boom',
			})
			expect(host.get(StrictFailPlugin)).toBeUndefined()
			expect(host.isRunning(StrictFailPlugin)).toBe(false)
		})
	})

	it('reports only the failed dependency subtree while leaving independent plugins running', async () => {
		await withCoreHost(async (host) => {
			independentStarted = 0
			host.add([FailingProvider, BlockedConsumer, IndependentPlugin])
			const summary = await host.commitAllowFail()

			// Only the failing root and its dependency chain should be marked failed.
			expect(new Set(pluginLifecycleIssuePlugins(summary))).toEqual(
				new Set([
					host.ctx.registry.resolvePluginNode(FailingProvider),
					host.ctx.registry.resolvePluginNode(BlockedConsumer),
				]),
			)
			expect(pluginLifecycleIssuePlugins(summary, { kind: 'dependency-blocked' })).toEqual([
				host.ctx.registry.resolvePluginNode(BlockedConsumer),
			])
			assertPluginLifecycleIssue(summary, FailingProvider, {
				phase: 'start',
				kind: 'start-failed',
				message: 'boom',
			})
			assertPluginLifecycleIssue(summary, BlockedConsumer, {
				phase: 'dependency',
				kind: 'dependency-blocked',
				blockedBy: FailingProvider,
			})
			expect(pluginLifecycleIssuePlugins(summary)).not.toContain(
				host.ctx.registry.resolvePluginNode(IndependentPlugin),
			)
			expect(host.isRunning(FailingProvider)).toBe(false)
			expect(host.isRunning(BlockedConsumer)).toBe(false)
			expect(host.isRunning(IndependentPlugin)).toBe(true)
			expect(independentStarted).toBe(1)
		})
	})
})

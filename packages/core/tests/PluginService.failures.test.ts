import { describe, expect, it } from 'vitest'
import { requirePluginService } from '@pluxel/core/internal'
import type { StandardSchemaV1 } from '@standard-schema/spec'

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

@Plugin({ displayName: 'CONSTRUCTION-ROLLBACK-FAILURE' })
class ConstructionRollbackFailure extends BasePlugin {
	constructor() {
		super()
		this.ctx.effects.defer(() => {
			throw new Error('construction cleanup boom')
		})
		throw new Error('construction boom')
	}
}

let configRollbackConstructions = 0
const ConfigRollbackSchema: StandardSchemaV1<unknown, { valid: true }> = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:test',
		validate: (value) =>
			value && typeof value === 'object' && (value as { valid?: unknown }).valid === true
				? { value: { valid: true as const } }
				: { issues: [{ message: 'config is invalid', path: ['valid'] }] },
	},
}

@Plugin({ displayName: 'CONFIG-ROLLBACK-FAILURE' })
class ConfigRollbackFailure extends BasePlugin {
	readonly config = this.configs.use(ConfigRollbackSchema)

	constructor() {
		super()
		const construction = ++configRollbackConstructions
		this.ctx.effects.defer(() => {
			if (construction === 1) throw new Error('config cleanup boom')
		})
	}
}

@Plugin({ displayName: 'INIT-ROLLBACK-FAILURE' })
class InitRollbackFailure extends BasePlugin {
	override init(): void {
		this.ctx.effects.defer(() => {
			throw new Error('init cleanup boom')
		})
		throw new Error('init boom')
	}
}

describe('PluginService failure reporting', () => {
	it('keeps the construction cause and reports rollback cleanup failure separately', async () => {
		await withCoreHost(async (host) => {
			host.add(ConstructionRollbackFailure)
			const summary = await host.commitAllowFail()

			assertPluginLifecycleIssue(summary, ConstructionRollbackFailure, {
				phase: 'resolve',
				kind: 'resolve-failed',
				message: 'construction boom',
			})
			assertPluginLifecycleIssue(summary, ConstructionRollbackFailure, {
				phase: 'drain',
				kind: 'drain-failed',
				message: 'construction cleanup boom',
			})
			expect(host.isRunning(ConstructionRollbackFailure)).toBe(false)
		})
	})

	it('keeps config injection failure and rollback drain failure, then constructs a fresh retry', async () => {
		await withCoreHost(async (host) => {
			configRollbackConstructions = 0
			host.add(ConfigRollbackFailure)
			const failed = await host.commitAllowFail()

			assertPluginLifecycleIssue(failed, ConfigRollbackFailure, {
				phase: 'config',
				kind: 'config-failed',
				message: 'Plugin config validation failed',
			})
			assertPluginLifecycleIssue(failed, ConfigRollbackFailure, {
				phase: 'drain',
				kind: 'drain-failed',
				message: 'config cleanup boom',
			})
			expect(configRollbackConstructions).toBe(1)
			expect(host.get(ConfigRollbackFailure)).toBeUndefined()

			host.cfg(ConfigRollbackFailure).set({ valid: true })
			await host.commit()
			expect(configRollbackConstructions).toBe(2)
			expect(host.require(ConfigRollbackFailure).config).toEqual({ valid: true })
		})
	})

	it('keeps init failure and its rollback drain failure in the same report', async () => {
		await withCoreHost(async (host) => {
			host.add(InitRollbackFailure)
			const summary = await host.commitAllowFail()

			assertPluginLifecycleIssue(summary, InitRollbackFailure, {
				phase: 'start',
				kind: 'start-failed',
				message: 'init boom',
			})
			assertPluginLifecycleIssue(summary, InitRollbackFailure, {
				phase: 'drain',
				kind: 'drain-failed',
				message: 'init cleanup boom',
			})
			expect(host.get(InitRollbackFailure)).toBeUndefined()
		})
	})

	it('commitStrict publishes failure details through runtimeCommitted before returning an error', async () => {
		await withCoreHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			const committed: CommitSummary[] = []

			const unsubscribe = registry.subscribeCommitted((summary) => {
				committed.push(summary)
			})
			host.ctx.effects.defer(unsubscribe)

			host.add(StrictFailPlugin)
			await expect(host.commit()).rejects.toThrow(/failed to start/)

			// Strict mode still publishes commit-side observability before surfacing the error result.
			expect(committed).toHaveLength(1)
			const published = committed[0]!
			const publishedIssue = published.lifecycleReport.issues[0]!
			expect(Object.isFrozen(published.lifecycleReport)).toBe(true)
			expect(Object.isFrozen(published.lifecycleReport.issues)).toBe(true)
			expect(Object.isFrozen(publishedIssue)).toBe(true)
			expect(Object.isFrozen(publishedIssue.error)).toBe(true)
			expect(() => (published.lifecycleReport.issues as unknown as unknown[]).pop()).toThrow(
				TypeError,
			)
			expect(pluginLifecycleIssuePlugins(committed[0]!)).toEqual([
				registry.resolvePluginNode(StrictFailPlugin),
			])
			expect(pluginLifecycleIssuePlugins(registry.lastCommit!)).toEqual([
				registry.resolvePluginNode(StrictFailPlugin),
			])
			assertPluginLifecycleIssue(registry.lastCommit!, StrictFailPlugin, {
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
			const registry = requirePluginService(host.ctx)
			independentStarted = 0
			host.add([FailingProvider, BlockedConsumer, IndependentPlugin])
			const summary = await host.commitAllowFail()

			// Only the failing root and its dependency chain should be marked failed.
			expect(new Set(pluginLifecycleIssuePlugins(summary))).toEqual(
				new Set([
					registry.resolvePluginNode(FailingProvider),
					registry.resolvePluginNode(BlockedConsumer),
				]),
			)
			expect(pluginLifecycleIssuePlugins(summary, { kind: 'dependency-blocked' })).toEqual([
				registry.resolvePluginNode(BlockedConsumer),
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
				registry.resolvePluginNode(IndependentPlugin),
			)
			expect(host.isRunning(FailingProvider)).toBe(false)
			expect(host.isRunning(BlockedConsumer)).toBe(false)
			expect(host.isRunning(IndependentPlugin)).toBe(true)
			expect(independentStarted).toBe(1)
		})
	})
})

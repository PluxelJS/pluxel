import { expect, it } from 'vitest'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import {
	BasePlugin,
	Plugin,
	type CommitSummary,
	assertPluginLifecycleIssue,
	createCoreInternalTestHost,
} from '@pluxel/core/internal/test'

@Plugin()
class FailedConstruction extends BasePlugin {
	constructor() {
		super()
		this.ctx.effects.defer(() => {
			throw new Error('constructor cleanup failed')
		})
		throw new Error('constructor failed')
	}
}

it('reports a constructor failure and still drains effects created before it', async () => {
	await using host = createCoreInternalTestHost()
	host.add(FailedConstruction)

	const summary = await host.commitAllowFail()
	assertPluginLifecycleIssue(summary, FailedConstruction, {
		kind: 'resolve-failed',
		message: 'constructor failed',
	})
	assertPluginLifecycleIssue(summary, FailedConstruction, {
		kind: 'drain-failed',
		message: 'constructor cleanup failed',
	})
	expect(host.get(FailedConstruction)).toBeUndefined()
})

const requiredConfig: StandardSchemaV1<unknown, { valid: true }> = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:test',
		validate: (value) =>
			(value as { valid?: unknown } | undefined)?.valid === true
				? { value: { valid: true as const } }
				: { issues: [{ message: 'expected valid configuration' }] },
	},
}
let constructions: number

@Plugin()
class Configured extends BasePlugin {
	readonly config = this.configs.use(requiredConfig)
	readonly construction = ++constructions

	constructor() {
		super()
		this.ctx.effects.defer(() => {
			if (this.construction === 1) throw new Error('config cleanup failed')
		})
	}
}

it('reports config rollback errors and builds a fresh generation after configuration is fixed', async () => {
	constructions = 0
	await using host = createCoreInternalTestHost()
	host.add(Configured)
	const failed = await host.commitAllowFail()
	assertPluginLifecycleIssue(failed, Configured, { kind: 'config-failed' })
	assertPluginLifecycleIssue(failed, Configured, {
		kind: 'drain-failed',
		message: 'config cleanup failed',
	})
	expect(host.get(Configured)).toBeUndefined()

	host.cfg(Configured).set({ valid: true })
	await host.commit()
	expect(host.require(Configured)).toMatchObject({ construction: 2, config: { valid: true } })
})

let failInit: boolean

@Plugin()
class RecoveringProvider extends BasePlugin {
	readonly generation = Symbol()

	override init() {
		if (failInit) {
			this.ctx.effects.defer(() => {
				throw new Error('provider rollback failed')
			})
			throw new Error('provider init failed')
		}
	}
}

@Plugin()
class Dependent extends BasePlugin {
	constructor(readonly provider: RecoveringProvider) {
		super()
	}
}

@Plugin()
class Independent extends BasePlugin {}

it('publishes strict init failures, blocks dependents, and retries without restarting unrelated nodes', async () => {
	failInit = true
	await using host = createCoreInternalTestHost()
	const independent = await host.start(Independent)
	let published: CommitSummary | undefined
	host.ctx.effects.defer(
		host.pluginService.subscribeCommitted((summary) => {
			published = summary
		}),
	)

	host.add([Dependent, RecoveringProvider])
	await expect(host.commit()).rejects.toThrow(/failed to start/)
	const failed = host.last()!
	expect(published).toBe(failed)
	assertPluginLifecycleIssue(failed, RecoveringProvider, {
		kind: 'start-failed',
		message: 'provider init failed',
	})
	assertPluginLifecycleIssue(failed, RecoveringProvider, {
		kind: 'drain-failed',
		message: 'provider rollback failed',
	})
	assertPluginLifecycleIssue(failed, Dependent, {
		kind: 'dependency-blocked',
		blockedBy: RecoveringProvider,
	})
	expect(failed.lifecycleReport.issues).toHaveLength(3)
	expect(host.get(RecoveringProvider)).toBeUndefined()
	expect(host.get(Dependent)).toBeUndefined()

	failInit = false
	await host.commit()
	expect(host.require(Dependent).provider.generation).toBe(
		host.require(RecoveringProvider).generation,
	)
	expect(host.require(Independent)).toBe(independent)
	expect(failed.lifecycleReport.issues).toHaveLength(3)
})

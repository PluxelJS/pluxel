import {
	BasePlugin,
	Plugin,
	PluginPart,
	assertPluginLifecycleIssue,
	createCoreInternalTestHost,
	definePluginRef,
} from '@pluxel/core/internal/test'
import { expect, it } from 'vitest'
import * as v from 'valibot'
import { consumePluginDefinitionCandidate } from '../src/internal'
import { validateConfigRecord } from '../src/services/config/ops'
import { lowerTestReplacement } from './lowered-replacement'

const ownerConfig = v.object({ title: v.string() })
const leafConfig = v.object({ quantity: v.number() })
const events: string[] = []

class Leaf extends PluginPart<Branch> {
	readonly config = this.configs.use(leafConfig)

	get branch() {
		return this.host
	}

	protected override init() {
		const quantity = this.config.quantity
		events.push(`leaf ${quantity}`)
		return () => {
			events.push(`stop leaf ${quantity}`)
		}
	}
}

class Branch extends PluginPart<Owner> {
	readonly first = this.parts.use(Leaf)
	readonly second = this.parts.use(Leaf)

	protected override init() {
		events.push('branch')
		return () => {
			events.push('stop branch')
		}
	}
}

@Plugin()
class Owner extends BasePlugin {
	readonly config = this.configs.use(ownerConfig)
	readonly branch = this.parts.use(Branch)

	override init() {
		events.push(this.config.title)
		return () => {
			events.push('stop owner')
		}
	}
}

it('gives each nested Part its own config and cleans up children after their owners', async () => {
	events.length = 0
	await using host = createCoreInternalTestHost()
	host
		.cfg(Owner)
		.set({ title: 'owner', branch: { first: { quantity: 1 }, second: { quantity: 2 } } })
	const owner = await host.start(Owner)
	expect(owner.branch.first.branch).toBe(owner.branch)
	expect(owner.branch.second.branch).toBe(owner.branch)
	expect(events).toEqual(['leaf 1', 'leaf 2', 'branch', 'owner'])

	host.remove(Owner)
	await host.commit()
	expect(events.slice(4)).toEqual(['stop owner', 'stop branch', 'stop leaf 2', 'stop leaf 1'])
})

it.each([
	{ title: 42, first: 1, path: ['title'] },
	{ title: 'owner', first: 'invalid', path: ['branch', 'first', 'quantity'] },
])(
	'preserves the validation path $path when composing owner and Part schemas',
	async ({ title, first, path }) => {
		const { config } = consumePluginDefinitionCandidate(Owner).declaration
		await expect(
			validateConfigRecord(config!.schema, {
				title,
				branch: { first: { quantity: first }, second: { quantity: 2 } },
			}),
		).resolves.toMatchObject({
			ok: false,
			errors: { _root: { [path[0]!]: [expect.objectContaining({ path })] } },
		})
	},
)

it('rejects constructing a Part outside its owner', () => {
	expect(() => Reflect.construct(Leaf, [])).toThrow(/can only be constructed by Core/)
})

let failProvider: boolean
const cleanupCallers: unknown[] = []

@Plugin({ forkable: true })
class Provider extends BasePlugin {
	ready = false
	readonly revision: string = 'original'

	override init() {
		if (failProvider) throw new Error('provider failed')
		this.ready = true
	}

	caller() {
		return this.ctx.caller
	}
}

class Integration extends PluginPart<DependentOwner> {
	constructor(readonly provider: Provider) {
		super()
		if (!provider.ready) throw new Error('provider must start before the Part is constructed')
	}

	callerIsPart() {
		return this.provider.caller() === this.ctx
	}

	protected override init() {
		return () => {
			cleanupCallers.push(this.callerIsPart())
		}
	}
}

@Plugin()
class DependentOwner extends BasePlugin {
	readonly first = this.parts.use(Integration)
	readonly second = this.parts.use(Integration)
}

it('lifts repeated Part dependencies into one owner edge and binds each occurrence to the selected fork', async () => {
	failProvider = true
	cleanupCallers.length = 0
	class Replacement extends Provider {
		override readonly revision = 'replacement'
	}
	lowerTestReplacement(Provider, Replacement, { plugin: { forkable: true } })

	await using host = createCoreInternalTestHost()
	host.add(DependentOwner)
	const fork = host.fork(Provider, 'parts')
	host.override(DependentOwner, Provider, fork)
	const failed = await host.commitAllowFail()
	assertPluginLifecycleIssue(failed, DependentOwner, {
		kind: 'dependency-blocked',
		blockedBy: fork,
	})
	expect(host.get(DependentOwner)).toBeUndefined()

	failProvider = false
	await host.commit()
	const first = host.require(DependentOwner)
	const raw = host.require(fork)
	expect(first.first.callerIsPart()).toBe(true)
	expect(first.second.callerIsPart()).toBe(true)
	expect(host.pluginService.readCommittedDependencyAdjacency().required).toEqual([
		{ consumer: first.ctx.pluginInfo.nodeAddress, provider: fork },
	])

	host.restart(DependentOwner)
	await host.commit()
	expect(host.require(fork)).toBe(raw)
	expect(cleanupCallers).toEqual([true, true])
	expect(() => first.first.provider.caller()).toThrow(/owner stopped/i)

	host.replace(Provider, Replacement)
	const replaced = await host.commit()
	expect(replaced.pluginChanges.restarted).toHaveLength(1)
	expect(host.require(DependentOwner).second.provider.revision).toBe('replacement')
})

const ProviderRef = definePluginRef<Provider>()

class OptionalIntegration extends PluginPart<OptionalOwner> {
	connected = false

	protected override init() {
		this.plugins.use(ProviderRef, () => {
			this.connected = true
			return () => {
				this.connected = false
			}
		})
	}
}

@Plugin()
class OptionalOwner extends BasePlugin {
	readonly integration = this.parts.use(OptionalIntegration)
}

it('reactivates an owner when a Part optional integration becomes available and cleans up on withdrawal', async () => {
	failProvider = false
	await using host = createCoreInternalTestHost()
	const absent = await host.start(OptionalOwner)
	expect(absent.integration.connected).toBe(false)

	await host.start(Provider)
	const connected = host.require(OptionalOwner)
	expect(connected.integration.connected).toBe(true)
	host.remove(Provider)
	await host.commit()
	expect(connected.integration.connected).toBe(false)
	expect(host.require(OptionalOwner).integration.connected).toBe(false)
})

type FailureStage = 'construction' | 'init' | 'cleanup'
let failAt: FailureStage | undefined
let cleaned: boolean

class FaultyLeaf extends PluginPart<FaultyBranch> {
	constructor() {
		super()
		if (failAt === 'construction') throw new Error('part construction failure')
	}

	protected override init() {
		this.ctx.effects.defer(() => {
			cleaned = true
		})
		if (failAt === 'init') throw new Error('part init failure')
		return () => {
			if (failAt === 'cleanup') throw new Error('part cleanup failure')
		}
	}
}

class FaultyBranch extends PluginPart<FaultyOwner> {
	readonly leaf = this.parts.use(FaultyLeaf)
}

@Plugin()
class FaultyOwner extends BasePlugin {
	readonly branch = this.parts.use(FaultyBranch)
}

it.each([
	{ stage: 'construction', kind: 'resolve-failed' },
	{ stage: 'init', kind: 'start-failed' },
	{ stage: 'cleanup', kind: 'drain-failed' },
] as const)(
	'reports Part $stage failures on the owning node with the complete path',
	async ({ stage, kind }) => {
		failAt = stage
		cleaned = false
		await using host = createCoreInternalTestHost()
		host.add(FaultyOwner)
		if (stage === 'cleanup') {
			await host.commit()
			host.remove(FaultyOwner)
		}
		const issue = assertPluginLifecycleIssue(await host.commitAllowFail(), FaultyOwner, { kind })
		expect(issue.error?.partPath).toEqual(['branch', 'leaf'])
		expect(issue.message).toContain(`part ${stage} failure`)
		expect(cleaned).toBe(stage !== 'construction')
		expect(host.get(FaultyOwner)).toBeUndefined()

		failAt = undefined
		await host.start(FaultyOwner)
	},
)

class CyclePart extends PluginPart<CycleOwner> {
	constructor(readonly dependency: CycleConsumer) {
		super()
	}
}

@Plugin()
class CycleOwner extends BasePlugin {
	readonly api = this.parts.use(CyclePart)
}

@Plugin()
class CycleConsumer extends BasePlugin {
	constructor(readonly dependency: CycleOwner) {
		super()
	}
}

it('identifies the Part request that introduces a dependency cycle', async () => {
	await using host = createCoreInternalTestHost()
	host.add([CycleOwner, CycleConsumer])
	await expect(host.commit()).rejects.toThrow(/Part api constructor \(required\)/)
})

let lateInit: ReturnType<typeof Promise.withResolvers<void>>
let lateCleanup: ReturnType<typeof Promise.withResolvers<void>>

class LatePart extends PluginPart<LateOwner> {
	protected override async init() {
		await lateInit.promise
		return lateCleanup.resolve
	}
}

@Plugin({ startTimeoutMs: 15 })
class LateOwner extends BasePlugin {
	readonly late = this.parts.use(LatePart)
}

it('releases a Part cleanup returned after its owner times out', async () => {
	lateInit = Promise.withResolvers()
	lateCleanup = Promise.withResolvers()
	await using host = createCoreInternalTestHost({ execution: { drainTimeoutMs: 20 } })
	host.add(LateOwner)
	const failed = await host.commitAllowFail()
	lateInit.resolve()
	assertPluginLifecycleIssue(failed, LateOwner, { kind: 'start-failed', message: 'start timeout' })
	await lateCleanup.promise
	expect(host.get(LateOwner)).toBeUndefined()
})

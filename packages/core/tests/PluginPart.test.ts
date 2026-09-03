import type { StandardSchemaV1 } from '@standard-schema/spec'
import { BasePlugin, definePluginRef, Plugin, PluginPart } from '@pluxel/core/test'
import { createCoreInternalTestHost, withCoreInternalTestHost } from '@pluxel/core/internal/test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { consumePluginDefinitionCandidate } from '../src/internal'
import { pluginPartContextOf } from '../src/plugins/composition/PluginPart'
import { lowerTestReplacement } from './lowered-replacement'

function objectSchema<T extends Record<string, unknown>>(
	defaults: T,
): StandardSchemaV1<unknown, T> {
	return {
		'~standard': {
			version: 1,
			vendor: 'pluxel:test',
			validate(value) {
				if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
					return { issues: [{ message: 'Expected an object' }] }
				}
				return { value: { ...defaults, ...(value as Partial<T> | undefined) } }
			},
		},
	}
}

const OwnerConfig = objectSchema({ ownerValue: 'owner-default' })
const BranchConfig = objectSchema({ branchValue: 10 })
const LeafConfig = objectSchema({ leafValue: 20 })

let trace: string[] = []

class LeafPart extends PluginPart<BranchPart> {
	readonly config = this.configs.use(LeafConfig)

	immediateHostForTest(): BranchPart {
		return this.host
	}

	protected override init() {
		trace.push(`leaf:init:${this.config.leafValue}`)
		this.ctx.effects.defer(() => {
			trace.push('leaf:cleanup')
		})
	}
}

class BranchPart extends PluginPart<OwnerPlugin> {
	readonly leaf = this.parts.use(LeafPart)
	readonly config = this.configs.use(BranchConfig)

	immediateHostForTest(): OwnerPlugin {
		return this.host
	}

	protected override init() {
		trace.push(`branch:init:${this.config.branchValue}`)
		return () => {
			trace.push('branch:cleanup')
		}
	}
}

class PeerPart extends PluginPart<OwnerPlugin> {
	protected override init() {
		trace.push('peer:init')
		return () => {
			trace.push('peer:cleanup')
		}
	}
}

@Plugin({ displayName: 'PluginPart lifecycle owner' })
class OwnerPlugin extends BasePlugin {
	readonly branch = this.parts.use(BranchPart)
	readonly peer = this.parts.use(PeerPart)
	readonly config = this.configs.use(OwnerConfig)

	override init() {
		trace.push(`owner:init:${this.config.ownerValue}`)
		return () => {
			trace.push('owner:cleanup')
		}
	}
}

class RepeatedPart extends PluginPart<RepeatedOwner> {}

@Plugin({ displayName: 'Repeated PluginPart owner' })
class RepeatedOwner extends BasePlugin {
	readonly first = this.parts.use(RepeatedPart)
	readonly second = this.parts.use(RepeatedPart)
}

let failureTrace: string[] = []

class FailingPart extends PluginPart<FailingOwner> {
	protected override init() {
		failureTrace.push('part:init')
		this.ctx.effects.defer(() => {
			failureTrace.push('part:cleanup')
		})
		throw new Error('part startup failed')
	}
}

@Plugin({ displayName: 'Failing PluginPart owner' })
class FailingOwner extends BasePlugin {
	readonly failing = this.parts.use(FailingPart)

	override init() {
		failureTrace.push('owner:init')
	}
}

let optionalOwnerStarts = 0
let optionalIntegrations = 0
let optionalCleanups = 0

@Plugin({ displayName: 'PluginPart optional provider' })
class PartOptionalProvider extends BasePlugin {}

const PartOptionalProviderRef = definePluginRef<PartOptionalProvider>()

class OptionalIntegrationPart extends PluginPart<PartOptionalOwner> {
	protected override init() {
		this.plugins.use(PartOptionalProviderRef, () => {
			optionalIntegrations++
			return () => {
				optionalCleanups++
			}
		})
	}
}

@Plugin({ displayName: 'PluginPart optional owner' })
class PartOptionalOwner extends BasePlugin {
	readonly integration = this.parts.use(OptionalIntegrationPart)
	readonly generation = ++optionalOwnerStarts
}

let latePartInit: Promise<void>
let resolveLatePartInit: () => void
let latePartCleanups = 0

function resetLatePart(): void {
	;({ promise: latePartInit, resolve: resolveLatePartInit } = Promise.withResolvers<void>())
	latePartCleanups = 0
}

resetLatePart()

class LatePart extends PluginPart<LatePartOwner> {
	protected override async init() {
		await latePartInit
		return () => {
			latePartCleanups++
		}
	}
}

@Plugin({ displayName: 'Late PluginPart owner', startTimeoutMs: 15 })
class LatePartOwner extends BasePlugin {
	readonly late = this.parts.use(LatePart)
}

@Plugin({ displayName: 'PluginPart required provider', forkable: true })
class PartRequiredProvider extends BasePlugin {
	calls = 0

	caller() {
		this.calls++
		return this.ctx.caller
	}
}

class PartRequiredProviderReplacement extends PartRequiredProvider {}

const PartRequiredProviderRef = definePluginRef<PartRequiredProvider>()

class FirstRequiredPart extends PluginPart<RequiredPartsOwner> {
	callerContext?: unknown

	constructor(readonly provider: PartRequiredProvider) {
		super()
	}

	protected override init() {
		this.callerContext = this.provider.caller()
	}
}

class SecondRequiredPart extends PluginPart<RequiredPartsOwner> {
	constructor(readonly provider: PartRequiredProvider) {
		super()
	}
}

class RequiredOptionalPart extends PluginPart<RequiredPartsOwner> {
	optionalProvider?: PartRequiredProvider

	constructor(readonly provider: PartRequiredProvider) {
		super()
	}

	protected override init() {
		this.plugins.use(PartRequiredProviderRef, (provider) => {
			this.optionalProvider = provider
		})
	}
}

class OptionalOnlyPart extends PluginPart<RequiredPartsOwner> {
	optionalProvider?: PartRequiredProvider

	protected override init() {
		this.plugins.use(PartRequiredProviderRef, (provider) => {
			this.optionalProvider = provider
		})
	}
}

class NestedRequiredLeaf extends PluginPart<NestedRequiredBranch> {
	constructor(readonly provider: PartRequiredProvider) {
		super()
	}
}

class NestedRequiredBranch extends PluginPart<RequiredPartsOwner> {
	readonly leaf = this.parts.use(NestedRequiredLeaf)
}

@Plugin({ displayName: 'PluginPart required owner' })
class RequiredPartsOwner extends BasePlugin {
	readonly first = this.parts.use(FirstRequiredPart)
	readonly firstAgain = this.parts.use(FirstRequiredPart)
	readonly second = this.parts.use(SecondRequiredPart)
	readonly requiredOptional = this.parts.use(RequiredOptionalPart)
	readonly optionalOnly = this.parts.use(OptionalOnlyPart)
	readonly nested = this.parts.use(NestedRequiredBranch)

	constructor(readonly provider: PartRequiredProvider) {
		super()
	}
}

class ThrowingConstructorPart extends PluginPart<ThrowingConstructorOwner> {
	constructor(_provider: PartRequiredProvider) {
		super()
		throw new Error('part construction failed')
	}
}

@Plugin({ displayName: 'Throwing PluginPart constructor owner' })
class ThrowingConstructorOwner extends BasePlugin {
	readonly broken = this.parts.use(ThrowingConstructorPart)
}

class CleanupFailurePart extends PluginPart<CleanupFailureOwner> {
	protected override init() {
		return () => {
			throw new Error('part cleanup failed')
		}
	}
}

@Plugin({ displayName: 'PluginPart cleanup failure owner' })
class CleanupFailureOwner extends BasePlugin {
	readonly failingCleanup = this.parts.use(CleanupFailurePart)
}

@Plugin({ displayName: 'Failing PluginPart required provider' })
class FailingPartRequiredProvider extends BasePlugin {
	override init() {
		throw new Error('required provider failed')
	}
}

class BlockedRequiredPart extends PluginPart<BlockedRequiredPartOwner> {
	constructor(readonly _provider: FailingPartRequiredProvider) {
		super()
	}
}

@Plugin({ displayName: 'Blocked PluginPart required owner' })
class BlockedRequiredPartOwner extends BasePlugin {
	readonly blocked = this.parts.use(BlockedRequiredPart)
}

const providerFirstOrder: string[] = []

@Plugin({ displayName: 'PluginPart ordering provider' })
class PartOrderingProvider extends BasePlugin {
	override init() {
		providerFirstOrder.push('provider')
	}
}

class OrderedRequiredPart extends PluginPart<PartOrderingOwner> {
	constructor(readonly _provider: PartOrderingProvider) {
		super()
	}

	protected override init() {
		providerFirstOrder.push('part')
	}
}

@Plugin({ displayName: 'PluginPart ordering owner' })
class PartOrderingOwner extends BasePlugin {
	readonly ordered = this.parts.use(OrderedRequiredPart)
}

class NestedThrowingLeaf extends PluginPart<NestedThrowingBranch> {
	constructor(readonly _provider: PartRequiredProvider) {
		super()
		throw new Error('nested part construction failed')
	}
}

class NestedThrowingBranch extends PluginPart<NestedThrowingOwner> {
	readonly broken = this.parts.use(NestedThrowingLeaf)
}

@Plugin({ displayName: 'Nested throwing PluginPart owner' })
class NestedThrowingOwner extends BasePlugin {
	readonly branch = this.parts.use(NestedThrowingBranch)
}

@Plugin({ displayName: 'Slow PluginPart provider' })
class SlowPartProvider extends BasePlugin {
	async hold(wait: Promise<void>): Promise<void> {
		await wait
	}
}

class SlowRequiredPart extends PluginPart<SlowPartOwner> {
	constructor(readonly provider: SlowPartProvider) {
		super()
	}
}

@Plugin({ displayName: 'Slow PluginPart owner' })
class SlowPartOwner extends BasePlugin {
	readonly slow = this.parts.use(SlowRequiredPart)
}

let partCleanupCaller: unknown

class CleanupUsesProviderPart extends PluginPart<CleanupUsesProviderOwner> {
	constructor(readonly provider: PartRequiredProvider) {
		super()
	}

	protected override init() {
		return () => {
			partCleanupCaller = this.provider.caller()
		}
	}
}

@Plugin({ displayName: 'PluginPart cleanup provider owner' })
class CleanupUsesProviderOwner extends BasePlugin {
	readonly cleanup = this.parts.use(CleanupUsesProviderPart)
}

class CycleRequiredPart extends PluginPart<CyclePartOwner> {
	constructor(readonly _consumer: CyclePartConsumer) {
		super()
	}
}

@Plugin({ displayName: 'PluginPart cycle owner' })
class CyclePartOwner extends BasePlugin {
	readonly api = this.parts.use(CycleRequiredPart)
}

@Plugin({ displayName: 'PluginPart cycle consumer' })
class CyclePartConsumer extends BasePlugin {
	constructor(readonly _owner: CyclePartOwner) {
		super()
	}
}

@Plugin({ displayName: 'PluginPart optional cycle provider' })
class CycleOptionalProvider extends BasePlugin {
	constructor(readonly _owner: CycleOptionalOwner) {
		super()
	}
}

const CycleOptionalProviderRef = definePluginRef<CycleOptionalProvider>()

@Plugin({ displayName: 'PluginPart optional cycle owner' })
class CycleOptionalOwner extends BasePlugin {
	protected override init() {
		this.plugins.use(CycleOptionalProviderRef, () => {})
	}
}

describe('owner-bound PluginPart', () => {
	beforeAll(() => {
		lowerTestReplacement(PartRequiredProvider, PartRequiredProviderReplacement, {
			plugin: { displayName: 'PluginPart required provider replacement', forkable: true },
		})
	})

	it('builds nested occurrences, injects config slices and cleans up in inverse ownership order', async () => {
		trace = []
		await withCoreInternalTestHost(async (host) => {
			host.cfg(OwnerPlugin).set({
				ownerValue: 'owner-custom',
				branch: { branchValue: 11, leaf: { leafValue: 21 } },
			})
			await host.start(OwnerPlugin)

			const owner = host.require(OwnerPlugin)
			expect(owner.branch.immediateHostForTest()).toBe(owner)
			expect(owner.branch.leaf.immediateHostForTest()).toBe(owner.branch)
			const partContexts = [
				pluginPartContextOf(owner.branch),
				pluginPartContextOf(owner.branch.leaf),
			]
			for (const partContext of partContexts) {
				expect(Object.hasOwn(partContext, 'partInfo')).toBe(false)
				expect(Object.hasOwn(partContext, 'pluginInfo')).toBe(true)
				expect(partContext.pluginInfo).toBe(owner.ctx.pluginInfo)
				const mutable = partContext as unknown as { pluginInfo: unknown }
				expect(() => {
					mutable.pluginInfo = {}
				}).toThrow(TypeError)
				expect(() => Object.defineProperty(partContext, 'pluginInfo', { value: {} })).toThrow(
					TypeError,
				)
				expect(Reflect.deleteProperty(partContext, 'pluginInfo')).toBe(false)
			}
			expect(owner.config).toEqual({ ownerValue: 'owner-custom' })
			expect(owner.branch.config).toEqual({ branchValue: 11 })
			expect(owner.branch.leaf.config).toEqual({ leafValue: 21 })
			expect(trace).toEqual([
				'leaf:init:21',
				'branch:init:11',
				'peer:init',
				'owner:init:owner-custom',
			])
		})

		expect(trace).toEqual([
			'leaf:init:21',
			'branch:init:11',
			'peer:init',
			'owner:init:owner-custom',
			'owner:cleanup',
			'peer:cleanup',
			'branch:cleanup',
			'leaf:cleanup',
		])
	})

	it('creates one instance and effects scope per occurrence', async () => {
		await withCoreInternalTestHost(async (host) => {
			const owner = await host.start(RepeatedOwner)
			expect(owner.first).toBeInstanceOf(RepeatedPart)
			expect(owner.second).toBeInstanceOf(RepeatedPart)
			expect(owner.first).not.toBe(owner.second)
			expect(pluginPartContextOf(owner.first).effects).not.toBe(
				pluginPartContextOf(owner.second).effects,
			)
		})
	})

	it('rejects direct construction', () => {
		expect(() => Reflect.construct(RepeatedPart, [])).toThrow('can only be constructed by Core')
	})

	it('lifts root and Part requirements into one graph edge with scoped facades', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([PartRequiredProvider, RequiredPartsOwner])
			await host.commit()

			const owner = host.require(RequiredPartsOwner)
			const rawProvider = host.require(PartRequiredProvider)
			const declaration = consumePluginDefinitionCandidate(RequiredPartsOwner).declaration
			expect(declaration.constructorRequires).toHaveLength(1)
			expect(declaration.requires).toHaveLength(1)
			expect(declaration.optional).toHaveLength(0)
			expect(owner.provider).not.toBe(rawProvider)
			expect(owner.first.provider).not.toBe(rawProvider)
			expect(owner.first.provider).not.toBe(owner.firstAgain.provider)
			expect(owner.first.provider).not.toBe(owner.second.provider)
			expect(owner.provider).not.toBe(owner.first.provider)
			expect(owner.provider.ctx.caller).toBe(owner.ctx)
			expect(owner.first.provider.ctx.caller).toBe(pluginPartContextOf(owner.first))
			expect(owner.firstAgain.provider.ctx.caller).toBe(pluginPartContextOf(owner.firstAgain))
			expect(owner.second.provider.ctx.caller).toBe(pluginPartContextOf(owner.second))
			expect(owner.nested.leaf.provider.ctx.caller).toBe(pluginPartContextOf(owner.nested.leaf))
			expect(Object.hasOwn(pluginPartContextOf(owner.nested.leaf), 'partInfo')).toBe(false)
			expect(owner.first.callerContext).toBe(pluginPartContextOf(owner.first))
			expect(owner.requiredOptional.optionalProvider).toBe(owner.requiredOptional.provider)
			expect(owner.optionalOnly.optionalProvider).not.toBe(owner.first.provider)
			expect(owner.optionalOnly.optionalProvider?.ctx.caller).toBe(
				pluginPartContextOf(owner.optionalOnly),
			)
		})
	})

	it('starts an aggregated Part provider before constructing and initializing the owner', async () => {
		providerFirstOrder.length = 0
		await withCoreInternalTestHost(async (host) => {
			host.add([PartOrderingOwner, PartOrderingProvider])
			await host.commit()
			expect(providerFirstOrder).toEqual(['provider', 'part'])
		})
	})

	it('attributes graph cycle edges to their owner and Part request sources', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([CyclePartOwner, CyclePartConsumer])
			await expect(host.commit()).rejects.toThrow(/Part api constructor \(required\)/)
		})

		await withCoreInternalTestHost(async (host) => {
			host.add([CycleOptionalOwner, CycleOptionalProvider])
			await expect(host.commit()).rejects.toThrow(/owner init plugins\.use\(\) \(optional\)/)
		})
	})

	it('applies one owner override to every Part occurrence facade', async () => {
		await withCoreInternalTestHost(async (host) => {
			const fork = host.fork(PartRequiredProvider, 'parts')
			host.add(RequiredPartsOwner)
			host.override(RequiredPartsOwner, PartRequiredProvider, fork)
			await host.commit()

			const owner = host.require(RequiredPartsOwner)
			const facades = [
				owner.provider,
				owner.first.provider,
				owner.firstAgain.provider,
				owner.second.provider,
				owner.requiredOptional.provider,
				owner.nested.leaf.provider,
			]
			expect(facades.map((provider) => provider.ctx.pluginInfo.nodeAddress)).toEqual(
				facades.map(() => fork),
			)
			expect(new Set(facades).size).toBe(facades.length)
		})
	})

	it('restarts the owner once and invalidates every Part facade on provider replacement', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([PartRequiredProvider, RequiredPartsOwner])
			await host.commit()
			const oldOwner = host.require(RequiredPartsOwner)
			const oldFacades = [
				oldOwner.first.provider,
				oldOwner.firstAgain.provider,
				oldOwner.second.provider,
				oldOwner.requiredOptional.provider,
				oldOwner.nested.leaf.provider,
			]

			host.replace(PartRequiredProvider, PartRequiredProviderReplacement)
			const summary = await host.commit()
			const nextOwner = host.require(RequiredPartsOwner)
			const nextFacades = [
				nextOwner.first.provider,
				nextOwner.firstAgain.provider,
				nextOwner.second.provider,
				nextOwner.requiredOptional.provider,
				nextOwner.nested.leaf.provider,
			]

			expect(host.require(PartRequiredProvider)).toBeInstanceOf(PartRequiredProviderReplacement)
			expect(summary.pluginChanges.restarted.map((node) => node.definition.exportName)).toEqual([
				'RequiredPartsOwner',
			])
			expect(nextFacades.map((facade, index) => facade === oldFacades[index])).toEqual(
				nextFacades.map(() => false),
			)
			for (const facade of oldFacades) {
				expect(() => facade.calls).toThrow(/stopped/i)
			}
		})
	})

	it('invalidates cached Part dependency facades when the owner generation restarts', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([PartRequiredProvider, RequiredPartsOwner])
			await host.commit()
			const oldOwner = host.require(RequiredPartsOwner)
			const oldFacade = oldOwner.first.provider
			const oldCaller = oldFacade.caller

			host.restart(RequiredPartsOwner)
			const restart = await host.commit()
			expect(restart.lifecycleReport.issues).toHaveLength(0)

			const nextOwner = host.require(RequiredPartsOwner)
			const nextFacade = nextOwner.first.provider
			expect(nextOwner === oldOwner).toBe(false)
			expect(nextOwner.ctx === oldOwner.ctx).toBe(false)
			expect(nextOwner.first === oldOwner.first).toBe(false)
			expect(pluginPartContextOf(nextOwner.first) === pluginPartContextOf(oldOwner.first)).toBe(
				false,
			)
			expect(nextFacade === oldFacade).toBe(false)
			expect(() => oldFacade.calls).toThrow('Plugin owner stopped')
			expect(() => oldCaller()).toThrow('Plugin owner stopped')
		})
	})

	it('drains an in-flight Part dependency call before completing owner teardown', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([SlowPartProvider, SlowPartOwner])
			await host.commit()
			const release = Promise.withResolvers<void>()
			const facade = host.require(SlowPartOwner).slow.provider
			const call = facade.hold(release.promise)

			host.remove(SlowPartOwner)
			let removed = false
			const removal = (async (): Promise<void> => {
				await host.commit()
				removed = true
			})()
			await new Promise<void>((resolve) => setTimeout(resolve, 0))
			expect(removed).toBe(false)

			release.resolve()
			await Promise.all([call, removal])
			expect(() => facade.hold(Promise.resolve())).toThrow(/owner stopped/i)
			expect(host.isRunning(SlowPartProvider)).toBe(true)
		})
	})

	it('keeps Part dependency facades usable by generation cleanup before invalidation', async () => {
		partCleanupCaller = undefined
		await withCoreInternalTestHost(async (host) => {
			host.add([PartRequiredProvider, CleanupUsesProviderOwner])
			await host.commit()
			const part = host.require(CleanupUsesProviderOwner).cleanup
			host.remove(CleanupUsesProviderOwner)
			await host.commit()
			expect(partCleanupCaller).toBe(pluginPartContextOf(part))
		})
	})

	it('reports Part constructor failure on the owning Plugin with its path', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([PartRequiredProvider, ThrowingConstructorOwner])
			const summary = await host.commitAllowFail()

			expect(host.isRunning(ThrowingConstructorOwner)).toBe(false)
			const issue = summary.lifecycleReport.issues.find(
				(item) => item.phase === 'resolve' && item.error?.partPath,
			)
			expect(issue?.error?.partPath).toEqual(['broken'])
			expect(issue?.error?.cause).toBe('part construction failed')
		})
	})

	it('preserves a nested constructor path and restores the construction stack after failure', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([PartRequiredProvider, NestedThrowingOwner])
			const failed = await host.commitAllowFail()
			const issue = failed.lifecycleReport.issues.find(
				(item) => item.phase === 'resolve' && item.error?.partPath,
			)
			expect(issue?.error?.partPath).toEqual(['branch', 'broken'])

			host.remove(NestedThrowingOwner)
			host.add(RequiredPartsOwner)
			await host.commit()
			expect(host.require(RequiredPartsOwner).nested.leaf.provider).toBeDefined()
		})
	})

	it('blocks the whole owner when a Part required provider fails', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([FailingPartRequiredProvider, BlockedRequiredPartOwner])
			const summary = await host.commitAllowFail()

			expect(host.isRunning(FailingPartRequiredProvider)).toBe(false)
			expect(host.isRunning(BlockedRequiredPartOwner)).toBe(false)
			expect(
				summary.lifecycleReport.issues.some(
					(item) => item.phase === 'dependency' && item.kind === 'dependency-blocked',
				),
			).toBe(true)
		})
	})

	it('attributes Part cleanup failures without creating a Part lifecycle state', async () => {
		const host = createCoreInternalTestHost()
		try {
			await host.start(CleanupFailureOwner)
			host.remove(CleanupFailureOwner)
			const summary = await host.commitAllowFail()
			const issue = summary.lifecycleReport.issues.find((item) => item.phase === 'drain')
			expect(issue?.error?.partPath).toEqual(['failingCleanup'])
			expect(issue?.message).toContain('part cleanup failed')
		} finally {
			await host.dispose()
		}
	})

	it('fails the owning Plugin and rolls back the Part scope when Part init rejects', async () => {
		failureTrace = []
		await withCoreInternalTestHost(async (host) => {
			host.add(FailingOwner)
			const summary = await host.commitAllowFail()
			expect(host.isRunning(FailingOwner)).toBe(false)
			const issue = summary.lifecycleReport.issues.find((item) => item.phase === 'start')
			expect(issue?.error?.partPath).toEqual(['failing'])
			expect(issue?.error?.cause).toBe('part startup failed')
			expect(failureTrace).toEqual(['part:init', 'part:cleanup'])
		})
	})

	it('lowers Part optional edges onto the owner and restarts the whole owner on availability changes', async () => {
		optionalOwnerStarts = 0
		optionalIntegrations = 0
		optionalCleanups = 0
		await withCoreInternalTestHost(async (host) => {
			await host.start(PartOptionalOwner)
			expect(optionalOwnerStarts).toBe(1)
			expect(optionalIntegrations).toBe(0)

			host.add(PartOptionalProvider)
			await host.commit()
			expect(optionalOwnerStarts).toBe(2)
			expect(optionalIntegrations).toBe(1)

			host.remove(PartOptionalProvider)
			await host.commit()
			expect(optionalOwnerStarts).toBe(3)
			expect(optionalCleanups).toBe(1)
		})
	})

	it('immediately disposes a cleanup returned after the owning generation timed out', async () => {
		resetLatePart()
		await withCoreInternalTestHost(
			async (host) => {
				host.add(LatePartOwner)
				await host.commitAllowFail()
				expect(host.isRunning(LatePartOwner)).toBe(false)
				resolveLatePartInit()
				await vi.waitFor(() => expect(latePartCleanups).toBe(1))
			},
			{ plugins: { drainTimeoutMs: 20 } },
		)
	})
})

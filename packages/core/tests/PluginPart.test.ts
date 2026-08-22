import type { StandardSchemaV1 } from '@standard-schema/spec'
import { BasePlugin, definePluginRef, Plugin, PluginPart, withCoreHost } from '@pluxel/core/test'
import { describe, expect, it, vi } from 'vitest'

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

	override init() {
		trace.push(`leaf:init:${this.config.leafValue}`)
		this.ctx.effects.defer(() => {
			trace.push('leaf:cleanup')
		})
	}
}

class BranchPart extends PluginPart<OwnerPlugin> {
	readonly leaf = this.parts.use(LeafPart)
	readonly config = this.configs.use(BranchConfig)

	override init() {
		trace.push(`branch:init:${this.config.branchValue}`)
		return () => {
			trace.push('branch:cleanup')
		}
	}
}

class PeerPart extends PluginPart<OwnerPlugin> {
	override init() {
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
	override init() {
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
	override init() {
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
	override async init() {
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

describe('owner-bound PluginPart', () => {
	it('builds nested occurrences, injects config slices and cleans up in inverse ownership order', async () => {
		trace = []
		await withCoreHost(async (host) => {
			host.cfg(OwnerPlugin).set({
				ownerValue: 'owner-custom',
				branch: { branchValue: 11, leaf: { leafValue: 21 } },
			})
			await host.start(OwnerPlugin)

			const owner = host.require(OwnerPlugin)
			expect(owner.branch.host).toBe(owner)
			expect(owner.branch.leaf.host).toBe(owner.branch)
			expect(owner.branch.leaf.plugin).toBe(owner)
			expect(owner.branch.ctx.partInfo.path).toEqual(['branch'])
			expect(owner.branch.leaf.ctx.partInfo.path).toEqual(['branch', 'leaf'])
			for (const partContext of [owner.branch.ctx, owner.branch.leaf.ctx]) {
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
		await withCoreHost(async (host) => {
			const owner = await host.start(RepeatedOwner)
			expect(owner.first).toBeInstanceOf(RepeatedPart)
			expect(owner.second).toBeInstanceOf(RepeatedPart)
			expect(owner.first).not.toBe(owner.second)
			expect(owner.first.ctx.effects).not.toBe(owner.second.ctx.effects)
		})
	})

	it('rejects direct construction', () => {
		expect(() => Reflect.construct(RepeatedPart, [])).toThrow(
			"Don't instantiate PluginPart directly",
		)
	})

	it('fails the owning Plugin and rolls back the Part scope when Part init rejects', async () => {
		failureTrace = []
		await withCoreHost(async (host) => {
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
		await withCoreHost(async (host) => {
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
		await withCoreHost(
			async (host) => {
				host.add(LatePartOwner)
				await host.commitAllowFail()
				expect(host.isRunning(LatePartOwner)).toBe(false)
				resolveLatePartInit()
				await vi.waitFor(() => expect(latePartCleanups).toBe(1))
			},
			{ registry: { drainTimeoutMs: 20 } },
		)
	})
})

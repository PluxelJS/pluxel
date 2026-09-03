import {
	createCoreContextInstallations,
	requirePluginService,
	resolveCoreRootInputs,
	type CoreCommitPublication,
	type CorePluginLifecycleHooks,
} from '@pluxel/core/internal'
import {
	BasePlugin,
	definePluginRef,
	Plugin,
	PluginPart,
	pluginNodeAddressOf,
} from '@pluxel/core/test'
import {
	createCoreInternalTestHost,
	type CoreInternalTestHostOptions,
	assertPluginLifecycleIssue,
} from '@pluxel/core/internal/test'
import { createContextHost, type RootContext } from '@pluxel/core'
import { describe, expect, it, vi } from 'vitest'

let lifecycleTrace: string[] = []

class OrderedPart extends PluginPart<OrderedPlugin> {
	protected override init() {
		lifecycleTrace.push('part:init')
	}
}

@Plugin({ displayName: 'Host lifecycle ordered Plugin' })
class OrderedPlugin extends BasePlugin {
	readonly part = this.parts.use(OrderedPart)

	override init() {
		lifecycleTrace.push('plugin:init')
	}
}

@Plugin({ displayName: 'Host finalizer failure' })
class FinalizerFailurePlugin extends BasePlugin {
	override init() {
		lifecycleTrace.push('failure:init')
	}
}

@Plugin({ displayName: 'Host finalizer blocked dependent' })
class FinalizerBlockedDependent extends BasePlugin {
	constructor(_provider: FinalizerFailurePlugin) {
		super()
	}
}

class BrokenPart extends PluginPart<BrokenPartOwner> {
	protected override init() {
		throw new Error('part lifecycle failure')
	}
}

@Plugin({ displayName: 'Host finalizer Part failure' })
class BrokenPartOwner extends BasePlugin {
	readonly broken = this.parts.use(BrokenPart)
}

let settleLateInit: () => void
let lateInit: Promise<void>

function resetLateInit(): void {
	;({ promise: lateInit, resolve: settleLateInit } = Promise.withResolvers<void>())
}

resetLateInit()

@Plugin({ displayName: 'Host finalizer late init', startTimeoutMs: 15 })
class LateFinalizerPlugin extends BasePlugin {
	override async init() {
		await lateInit
	}
}

@Plugin({ displayName: 'Parallel finalizer A' })
class ParallelFinalizerA extends BasePlugin {}

@Plugin({ displayName: 'Parallel finalizer B' })
class ParallelFinalizerB extends BasePlugin {}

@Plugin({ displayName: 'Settled provider' })
class SettledProvider extends BasePlugin {}

@Plugin({ displayName: 'Settled required dependent' })
class SettledRequiredDependent extends BasePlugin {
	constructor(_provider: SettledProvider) {
		super()
	}
}

const SettledProviderRef = definePluginRef<SettledProvider>()
let optionalSettlementStarts = 0
let optionalSettlementIntegrations = 0
let optionalSettlementCleanups = 0

@Plugin({ displayName: 'Settled optional dependent' })
class SettledOptionalDependent extends BasePlugin {
	readonly generation = ++optionalSettlementStarts

	override init() {
		this.plugins.use(SettledProviderRef, () => {
			optionalSettlementIntegrations++
			return () => {
				optionalSettlementCleanups++
			}
		})
	}
}

function createRootFactory(
	hooks: CorePluginLifecycleHooks,
): CoreInternalTestHostOptions['createRootContext'] {
	return (config) => {
		const inputs = resolveCoreRootInputs(config)
		const contextHost = createContextHost({
			name: 'core-host-lifecycle-test',
			capabilities: createCoreContextInstallations(inputs, hooks),
		})
		return contextHost.createRoot(inputs.name) as RootContext
	}
}

describe('Core host lifecycle seams', () => {
	it('finalizes after Part and Plugin init, then publishes before stable readers', async () => {
		lifecycleTrace = []
		let registry!: ReturnType<typeof requirePluginService>
		let publication!: CoreCommitPublication
		let preparedPublication: CoreCommitPublication | undefined
		let finalizerOperation: object | undefined
		const host = createCoreInternalTestHost(
			{},
			{
				createRootContext: createRootFactory({
					finalizeGeneration: ({ ctx, operation, signal }) => {
						expect(signal.aborted).toBe(false)
						finalizerOperation = operation
						expect(ctx.pluginInfo.nodeAddress).toEqual(pluginNodeAddressOf(OrderedPlugin))
						expect(registry.isRunning(OrderedPlugin)).toBe(false)
						lifecycleTrace.push('host:finalize')
					},
					prepareCommit: async (fact) => {
						await Promise.resolve()
						preparedPublication = fact
						expect(registry.lastCommit).toBeUndefined()
						lifecycleTrace.push('host:prepare')
					},
					publishCommit: (fact) => {
						expect(fact).toBe(preparedPublication)
						publication = fact
						expect(registry.isRunning(OrderedPlugin)).toBe(true)
						expect(registry.lastCommit).toBeUndefined()
						lifecycleTrace.push('host:publish')
						return undefined
					},
				}),
			},
		)
		try {
			registry = requirePluginService(host.ctx)
			expect('finalizeGeneration' in host.ctx).toBe(false)
			expect('settleGenerations' in host.ctx).toBe(false)
			expect('prepareCommit' in host.ctx).toBe(false)
			expect('publishCommit' in host.ctx).toBe(false)
			const node = registry.internNodeAddress(pluginNodeAddressOf(OrderedPlugin))
			const unwatch = registry.watchInstance(node, (instance) => {
				if (instance) lifecycleTrace.push('watcher')
			})
			const unsubscribe = registry.subscribeCommitted(() => lifecycleTrace.push('listener'))
			host.ctx.effects.defer(unwatch)
			host.ctx.effects.defer(unsubscribe)

			host.add(OrderedPlugin)
			await host.commit()
			lifecycleTrace.push('returned')

			expect(lifecycleTrace).toEqual([
				'part:init',
				'plugin:init',
				'host:finalize',
				'host:prepare',
				'host:publish',
				'watcher',
				'listener',
				'returned',
			])
			expect(publication.operation).toEqual({ revision: 1, reason: 'core-test' })
			expect(publication.operation).toBe(finalizerOperation)
			expect(publication.started).toEqual([host.require(OrderedPlugin).ctx])
			expect(publication.stopped).toEqual([])
			expect(publication.failed).toEqual([])
			expect(Object.isFrozen(publication)).toBe(true)
			expect(Object.isFrozen(publication.operation)).toBe(true)
			expect(Object.isFrozen(publication.started)).toBe(true)
		} finally {
			await host.dispose()
		}
	})

	it('treats finalizer failure as start failure and rolls back generation effects', async () => {
		lifecycleTrace = []
		let publication!: CoreCommitPublication
		const host = createCoreInternalTestHost(
			{},
			{
				createRootContext: createRootFactory({
					finalizeGeneration: ({ ctx }) => {
						lifecycleTrace.push('host:finalize')
						ctx.effects.defer(() => {
							lifecycleTrace.push('host:cleanup')
						})
						throw new Error('host finalization failed')
					},
					publishCommit: (fact) => {
						publication = fact
						return undefined
					},
				}),
			},
		)
		try {
			host.add([FinalizerFailurePlugin, FinalizerBlockedDependent])
			const summary = await host.commitAllowFail()

			assertPluginLifecycleIssue(summary, FinalizerFailurePlugin, {
				phase: 'start',
				kind: 'start-failed',
				message: 'host finalization failed',
			})
			assertPluginLifecycleIssue(summary, FinalizerBlockedDependent, {
				phase: 'dependency',
				kind: 'dependency-blocked',
				blockedBy: FinalizerFailurePlugin,
			})
			expect(host.isRunning(FinalizerFailurePlugin)).toBe(false)
			expect(host.isRunning(FinalizerBlockedDependent)).toBe(false)
			expect(lifecycleTrace).toEqual(['failure:init', 'host:finalize', 'host:cleanup'])
			expect(publication.started).toEqual([])
			expect(publication.failed).toHaveLength(2)
		} finally {
			await host.dispose()
		}
	})

	it('does not finalize a generation when Part init fails', async () => {
		let finalizations = 0
		let publication!: CoreCommitPublication
		const host = createCoreInternalTestHost(
			{},
			{
				createRootContext: createRootFactory({
					finalizeGeneration: () => {
						finalizations++
					},
					publishCommit: (fact) => {
						publication = fact
						return undefined
					},
				}),
			},
		)
		try {
			host.add(BrokenPartOwner)
			const summary = await host.commitAllowFail()
			assertPluginLifecycleIssue(summary, BrokenPartOwner, {
				phase: 'start',
				kind: 'start-failed',
				message: 'part lifecycle failure',
			})
			expect(finalizations).toBe(0)
			expect(publication.started).toEqual([])
			expect(publication.failed).toHaveLength(1)
		} finally {
			await host.dispose()
		}
	})

	it('does not run a finalizer after late init loses the generation', async () => {
		resetLateInit()
		let finalizations = 0
		const host = createCoreInternalTestHost(
			{ plugins: { drainTimeoutMs: 20 } },
			{
				createRootContext: createRootFactory({
					finalizeGeneration: () => {
						finalizations++
					},
					publishCommit: () => undefined,
				}),
			},
		)
		try {
			host.add(LateFinalizerPlugin)
			const summary = await host.commitAllowFail()
			assertPluginLifecycleIssue(summary, LateFinalizerPlugin, {
				phase: 'start',
				kind: 'start-failed',
				message: 'start timeout',
			})
			settleLateInit()
			await vi.waitFor(() => expect(host.isRunning(LateFinalizerPlugin)).toBe(false))
			expect(finalizations).toBe(0)
		} finally {
			await host.dispose()
		}
	})

	it('aborts a timed-out finalizer without publishing the generation as running', async () => {
		const gate = Promise.withResolvers<void>()
		let finalizerSignal: AbortSignal | undefined
		let publication!: CoreCommitPublication
		const host = createCoreInternalTestHost(
			{ plugins: { startTimeoutMs: 20, drainTimeoutMs: 20 } },
			{
				createRootContext: createRootFactory({
					finalizeGeneration: async ({ signal }) => {
						finalizerSignal = signal
						await gate.promise
					},
					publishCommit: (fact) => {
						publication = fact
						return undefined
					},
				}),
			},
		)
		try {
			host.add(OrderedPlugin)
			const summary = await host.commitAllowFail()
			assertPluginLifecycleIssue(summary, OrderedPlugin, {
				phase: 'start',
				kind: 'start-failed',
				message: 'start timeout',
			})
			expect(finalizerSignal?.aborted).toBe(true)
			expect(publication.started).toEqual([])
			expect(publication.failed).toHaveLength(1)
			gate.resolve()
			await vi.waitFor(() => expect(host.isRunning(OrderedPlugin)).toBe(false))
		} finally {
			gate.resolve()
			await host.dispose()
		}
	})

	it('settles parallel inverse completion in stable order and skips a failed predecessor', async () => {
		const releaseFirst = Promise.withResolvers<void>()
		const completions: string[] = []
		const settled: string[][] = []
		let publication!: CoreCommitPublication
		const host = createCoreInternalTestHost(
			{ plugins: { startConcurrency: 2 } },
			{
				createRootContext: createRootFactory({
					finalizeGeneration: async ({ ctx }) => {
						const exportName = ctx.pluginInfo.nodeAddress.definition.exportName
						if (exportName === 'ParallelFinalizerA') {
							await releaseFirst.promise
							completions.push('A:failed')
							throw new Error('parallel predecessor failed')
						}
						completions.push('B:complete')
						releaseFirst.resolve()
					},
					settleGenerations: ({ started }) => {
						settled.push(started.map((ctx) => ctx.pluginInfo.nodeAddress.definition.exportName))
					},
					publishCommit: (fact) => {
						publication = fact
						return undefined
					},
				}),
			},
		)
		try {
			host.add([ParallelFinalizerB, ParallelFinalizerA])
			const summary = await host.commitAllowFail()
			assertPluginLifecycleIssue(summary, ParallelFinalizerA, {
				phase: 'start',
				kind: 'start-failed',
				message: 'parallel predecessor failed',
			})
			expect(completions).toEqual(['B:complete', 'A:failed'])
			expect(settled).toEqual([['ParallelFinalizerB']])
			expect(publication.started.map((ctx) => ctx.pluginInfo.nodeAddress)).toEqual([
				pluginNodeAddressOf(ParallelFinalizerB),
			])
			expect(publication.failed).toEqual([
				requirePluginService(host.ctx).resolvePluginNode(ParallelFinalizerA),
			])
		} finally {
			await host.dispose()
		}
	})

	it('turns settlement rejection into start failure and restarts optional dependents', async () => {
		optionalSettlementStarts = 0
		optionalSettlementIntegrations = 0
		optionalSettlementCleanups = 0
		const settlementBatches: Array<{ started: string[]; stopped: string[] }> = []
		let publication!: CoreCommitPublication
		const host = createCoreInternalTestHost(
			{},
			{
				createRootContext: createRootFactory({
					settleGenerations: ({ started, stopped }) => {
						settlementBatches.push({
							started: started.map((ctx) => ctx.pluginInfo.nodeAddress.definition.exportName),
							stopped: stopped.map((ctx) => ctx.pluginInfo.nodeAddress.definition.exportName),
						})
						const provider = started.find(
							(ctx) => ctx.pluginInfo.nodeAddress.definition.exportName === 'SettledProvider',
						)
						return provider
							? [Object.freeze({ ctx: provider, error: new Error('route collision') })]
							: undefined
					},
					publishCommit: (fact) => {
						publication = fact
						return undefined
					},
				}),
			},
		)
		try {
			host.add([SettledOptionalDependent, SettledRequiredDependent, SettledProvider])
			const summary = await host.commitAllowFail()

			assertPluginLifecycleIssue(summary, SettledProvider, {
				phase: 'start',
				kind: 'start-failed',
				message: 'route collision',
			})
			assertPluginLifecycleIssue(summary, SettledRequiredDependent, {
				phase: 'dependency',
				kind: 'dependency-blocked',
				blockedBy: SettledProvider,
			})
			expect(settlementBatches).toEqual([
				{
					started: ['SettledProvider', 'SettledOptionalDependent', 'SettledRequiredDependent'],
					stopped: [],
				},
				{
					started: ['SettledOptionalDependent'],
					stopped: ['SettledProvider', 'SettledOptionalDependent', 'SettledRequiredDependent'],
				},
			])
			expect(optionalSettlementStarts).toBe(2)
			expect(optionalSettlementIntegrations).toBe(1)
			expect(optionalSettlementCleanups).toBe(1)
			expect(host.isRunning(SettledProvider)).toBe(false)
			expect(host.isRunning(SettledRequiredDependent)).toBe(false)
			expect(host.require(SettledOptionalDependent).generation).toBe(2)
			expect(publication.started).toEqual([host.require(SettledOptionalDependent).ctx])
			expect(
				publication.stopped.map((ctx) => ctx.pluginInfo.nodeAddress.definition.exportName),
			).toEqual(['SettledProvider', 'SettledOptionalDependent', 'SettledRequiredDependent'])
			expect(publication.failed).toHaveLength(2)
		} finally {
			await host.dispose()
		}
	})

	it('serializes a queued commit and gives both hooks the same operation identity', async () => {
		const finalizerOperations: object[] = []
		const publications: CoreCommitPublication[] = []
		const settlements: Array<{ started: readonly object[]; stopped: readonly object[] }> = []
		let registry!: ReturnType<typeof requirePluginService>
		let queued: Promise<void> | undefined
		let reentrantUpdateError: unknown
		const host = createCoreInternalTestHost(
			{},
			{
				createRootContext: createRootFactory({
					finalizeGeneration: ({ operation }) => {
						finalizerOperations.push(operation)
					},
					settleGenerations: ({ started, stopped }) => {
						settlements.push({ started, stopped })
					},
					publishCommit: (publication) => {
						publications.push(publication)
						if (publications.length === 1) {
							try {
								registry.beginUpdate()
							} catch (error) {
								reentrantUpdateError = error
							}
							queued = registry.afterCurrentCommit(async () => {
								const update = registry.beginUpdate({ reason: 'queued-restart' })
								update.restartNode(pluginNodeAddressOf(OrderedPlugin))
								const result = await update.commit()
								if (result.ok === false) throw result.err
							})
						}
						return undefined
					},
				}),
			},
		)
		try {
			registry = requirePluginService(host.ctx)
			host.add(OrderedPlugin)
			await host.commit()
			await queued

			expect(publications).toHaveLength(2)
			expect(reentrantUpdateError).toBeInstanceOf(Error)
			expect((reentrantUpdateError as Error).message).toContain('another update is active')
			expect(publications.map((item) => item.operation.revision)).toEqual([1, 2])
			expect(publications.map((item) => item.operation.reason)).toEqual([
				'core-test',
				'queued-restart',
			])
			expect(finalizerOperations).toEqual(publications.map((item) => item.operation))
			expect(publications[1]!.started).toHaveLength(1)
			expect(publications[1]!.stopped).toHaveLength(1)
			expect(publications[1]!.started[0]).not.toBe(publications[1]!.stopped[0])
			expect(settlements).toHaveLength(2)
			expect(settlements[1]!.started).toEqual(publications[1]!.started)
			expect(settlements[1]!.stopped).toEqual(publications[1]!.stopped)
		} finally {
			await host.dispose()
		}
	})

	it('prepares removal-only final facts even when there are no candidates to settle', async () => {
		const settlements: Array<{
			started: readonly object[]
			stopped: readonly object[]
		}> = []
		const preparations: CoreCommitPublication[] = []
		const publications: CoreCommitPublication[] = []
		const host = createCoreInternalTestHost(
			{},
			{
				createRootContext: createRootFactory({
					settleGenerations: (fact) => {
						settlements.push(fact)
					},
					prepareCommit: (fact) => {
						preparations.push(fact)
					},
					publishCommit: (fact) => {
						publications.push(fact)
						return undefined
					},
				}),
			},
		)
		try {
			host.add(OrderedPlugin)
			await host.commit()
			const firstContext = host.require(OrderedPlugin).ctx
			host.remove(OrderedPlugin)
			await host.commit()

			expect(settlements).toHaveLength(1)
			expect(preparations).toHaveLength(2)
			expect(publications).toHaveLength(2)
			expect(preparations[1]).toBe(publications[1])
			expect(publications[1]!.started).toEqual([])
			expect(publications[1]!.stopped).toEqual([firstContext])
			expect(publications[1]!.failed).toEqual([])
		} finally {
			await host.dispose()
		}
	})

	it('rejects the original host publication error before summary or watcher visibility', async () => {
		const publicationError = new Error('host pointer exchange failed')
		const host = createCoreInternalTestHost(
			{},
			{
				createRootContext: createRootFactory({
					publishCommit: () => {
						throw publicationError
					},
				}),
			},
		)
		const registry = requirePluginService(host.ctx)
		const summaries: unknown[] = []
		const instances: unknown[] = []
		registry.subscribeCommitted((summary) => summaries.push(summary))
		const node = registry.internNodeAddress(pluginNodeAddressOf(OrderedPlugin))
		registry.watchInstance(node, (instance) => instances.push(instance))

		host.add(OrderedPlugin)
		let rejected: unknown
		try {
			await host.commit()
		} catch (error) {
			rejected = error
		}

		expect(rejected).toBe(publicationError)
		expect(registry.lastCommit).toBeUndefined()
		expect(summaries).toEqual([])
		expect(instances).toEqual([undefined])
		expect(() => registry.beginUpdate()).toThrow(
			'Cannot update a Core Plugin root after host commit publication failed',
		)
	})

	it('poisons the root when final commit preparation fails before pointer publication', async () => {
		const preparationError = new Error('dispatcher build failed')
		let published = false
		const host = createCoreInternalTestHost(
			{},
			{
				createRootContext: createRootFactory({
					prepareCommit: async () => {
						await Promise.resolve()
						throw preparationError
					},
					publishCommit: () => {
						published = true
						return undefined
					},
				}),
			},
		)
		const registry = requirePluginService(host.ctx)
		host.add(OrderedPlugin)
		let rejected: unknown
		try {
			await host.commit()
		} catch (error) {
			rejected = error
		}

		expect(rejected).toBe(preparationError)
		expect(published).toBe(false)
		expect(registry.lastCommit).toBeUndefined()
		expect(() => registry.beginUpdate()).toThrow(
			'Cannot update a Core Plugin root after host commit publication failed',
		)
	})

	it('rejects an asynchronous publication callback instead of exposing a delayed swap', async () => {
		const invalidPublication = (async () => {}) as unknown as NonNullable<
			CorePluginLifecycleHooks['publishCommit']
		>
		const host = createCoreInternalTestHost(
			{},
			{
				createRootContext: createRootFactory({ publishCommit: invalidPublication }),
			},
		)
		const registry = requirePluginService(host.ctx)
		host.add(OrderedPlugin)

		await expect(host.commit()).rejects.toThrow(
			'Host commit publication must be synchronous and return undefined',
		)
		expect(registry.lastCommit).toBeUndefined()
		expect(() => registry.beginUpdate()).toThrow(
			'Cannot update a Core Plugin root after host commit publication failed',
		)
	})
})

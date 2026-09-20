import {
	pluginDefinitionAddressOf,
	pluginDefinitionIndexKey,
	type BasePlugin,
	type CommitSummary,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
	type RootContext,
} from '@pluxel/core'
import {
	closeOwnerInvocations,
	consumePluginDefinitionCandidate,
	requireConfigService,
	requirePluginService,
	type ConcretePluginDefinitionCandidate,
	type PluginService,
} from '@pluxel/core/internal'
import {
	collectPluginLifecycleNotStarted,
	type CoreHostConfigHandle,
	type PluginConstructor,
	type PluginNodeHandle,
} from '@pluxel/core/internal/test'
import { type ServiceInternalTestHostOptions } from './options'
import { resolveContextCapability } from '@pluxel/core/host'
import {
	applyHostStatePatch,
	createPluginCatalogSnapshot,
	requirePluginHostCoordinator,
	PluginGraphRejectedError,
	hostStatePatch,
	type PluginCatalogEntryInput,
	type PluginHostCoordinator,
	type HostStatePatchOperation,
	requireHostStateStore,
	isPluginAutoStartEnabled,
	type HostStateStore,
} from '@pluxel/host/internal'

import { createServiceTestApplication, type ServiceInternalTestRootOptions } from './service-root'

/** A raw Host catalog/lifecycle target for framework-owned white-box tests. */
export type ServiceInternalTestTarget = PluginConstructor | PluginNodeAddress

type TypedTarget<TPlugin extends PluginConstructor> = TPlugin | PluginNodeHandle<TPlugin>

/** The internal config handle extends Core's raw config mutation with staged policy. */
export type ServiceInternalTestConfigHandle<TPlugin extends PluginConstructor> =
	CoreHostConfigHandle<TPlugin> & {
		setAutoStart(autoStart: boolean): void
		autoStart(): boolean
	}

/**
 * Privileged Service test authority.
 *
 * Framework protocol suites can stage catalog, raw config and lifecycle before one commit. Plugin-author tests must use `createServiceTestHost()` from `@pluxel/services/test`.
 */
export interface ServiceInternalTestHarness extends AsyncDisposable {
	readonly ctx: RootContext
	readonly root: RootContext
	readonly pluginService: PluginService
	readonly configService: ReturnType<typeof requireConfigService>
	readonly coordinator: PluginHostCoordinator<CommitSummary>
	readonly stateStore: HostStateStore
	fetch(request: Request): Promise<Response>
	add(plugin: PluginConstructor): ServiceInternalTestHarness
	add(plugins: readonly PluginConstructor[]): ServiceInternalTestHarness
	remove(target: ServiceInternalTestTarget): ServiceInternalTestHarness
	remove(targets: readonly ServiceInternalTestTarget[]): ServiceInternalTestHarness
	start(target: ServiceInternalTestTarget): ServiceInternalTestHarness
	stop(target: ServiceInternalTestTarget): ServiceInternalTestHarness
	restart(target: ServiceInternalTestTarget): ServiceInternalTestHarness
	replace(target: ServiceInternalTestTarget, next: PluginConstructor): ServiceInternalTestHarness
	fork<TPlugin extends PluginConstructor>(
		plugin: TPlugin,
		forkId: string,
	): PluginNodeHandle<TPlugin>
	override(
		consumer: ServiceInternalTestTarget,
		requirement: PluginConstructor | PluginDefinitionAddress,
		provider: PluginNodeAddress | null,
	): ServiceInternalTestHarness
	commit(): Promise<CommitSummary>
	commitAllowFail(): Promise<CommitSummary>
	isRunning(target: ServiceInternalTestTarget): boolean
	get<TPlugin extends PluginConstructor>(
		target: TypedTarget<TPlugin>,
	): InstanceType<TPlugin> | undefined
	get(target: PluginNodeAddress): BasePlugin | undefined
	require<TPlugin extends PluginConstructor>(target: TypedTarget<TPlugin>): InstanceType<TPlugin>
	require(target: PluginNodeAddress): BasePlugin
	cfg<TPlugin extends PluginConstructor>(
		target: TypedTarget<TPlugin>,
	): ServiceInternalTestConfigHandle<TPlugin>
	plugins(): PluginConstructor[]
	dispose(): Promise<void>
}

/** Root-only authority for service tests that do not need a staged catalog. */
export interface ServiceInternalTestContext extends AsyncDisposable {
	readonly ctx: RootContext
	readonly root: RootContext
	dispose(): Promise<void>
}

function assertCoreCommit(
	result: Awaited<ReturnType<ReturnType<PluginService['beginUpdate']>['commit']>>,
	pluginService: PluginService,
): CommitSummary {
	if (result.ok === false) {
		throw result.err instanceof Error ? result.err : new Error(String(result.err))
	}
	const summary = pluginService.lastCommit
	if (!summary) throw new Error('Service internal test Core commit omitted CommitSummary')
	return summary
}

function assertCommitStarted(summary: CommitSummary): void {
	const failed = collectPluginLifecycleNotStarted(summary.lifecycleReport).map(
		(plugin) => plugin.definition.exportName,
	)
	if (failed.length > 0) {
		throw new Error(`Some plugins failed to start: ${[...new Set(failed)].join(', ')}`)
	}
}

/**
 * Creates the service framework's raw staged test harness.
 *
 * It owns the Host coordinator transaction directly; do not compose a Core internal host
 * here because that would introduce a competing catalog/lifecycle transaction model.
 */
export async function createServiceInternalTestHarness(
	config: ServiceInternalTestHostOptions = {},
	rootOptions: ServiceInternalTestRootOptions = {},
): Promise<ServiceInternalTestHarness> {
	const application = await createServiceTestApplication(config, rootOptions)
	const ctx = application.ctx
	const pluginService = requirePluginService(ctx)
	const configService = requireConfigService(ctx)
	const stateStore = requireHostStateStore(ctx)
	const coordinator = requirePluginHostCoordinator(ctx)

	const addressByImplementation = new WeakMap<PluginConstructor, PluginDefinitionAddress>()
	let committedEntries = new Map<string, PluginCatalogEntryInput>()
	let draftEntries = new Map(committedEntries)
	let catalogDirty = false
	let stateOperations: HostStatePatchOperation[] = []
	let lifecycleCommands: Array<{
		address: PluginNodeAddress
		desiredState: 'running' | 'stopped'
	}> = []
	let retryStartNodes: PluginNodeAddress[] = []
	let restartNodes: PluginNodeAddress[] = []
	let firstCommit = true
	let disposal: Promise<void> | undefined

	const candidateFor = (plugin: PluginConstructor): ConcretePluginDefinitionCandidate => {
		const candidate = consumePluginDefinitionCandidate(plugin)
		addressByImplementation.set(plugin, candidate.declaration.address)
		return candidate
	}
	const definitionAddress = (plugin: PluginConstructor): PluginDefinitionAddress =>
		addressByImplementation.get(plugin) ?? pluginDefinitionAddressOf(plugin)
	const targetAddress = (target: ServiceInternalTestTarget): PluginNodeAddress =>
		typeof target === 'function'
			? { definition: definitionAddress(target), variant: 'default' }
			: target
	const stageCatalogCandidate = (candidate: ConcretePluginDefinitionCandidate): void => {
		const key = pluginDefinitionIndexKey(candidate.declaration.address)
		const current = draftEntries.get(key)
		if (current?.candidate === candidate) return
		if (current && current.candidate.implementation !== candidate.implementation) {
			throw new Error('Use harness.replace() to change a Plugin definition implementation')
		}
		draftEntries.set(key, Object.freeze({ candidate }))
		catalogDirty = true
	}
	const stagePlugin = (plugin: PluginConstructor): void =>
		stageCatalogCandidate(candidateFor(plugin))
	const stageState = (...operations: readonly HostStatePatchOperation[]): void => {
		stateOperations.push(...operations)
	}

	let harness!: ServiceInternalTestHarness
	function add(plugin: PluginConstructor): ServiceInternalTestHarness
	function add(plugins: readonly PluginConstructor[]): ServiceInternalTestHarness
	function add(
		value: PluginConstructor | readonly PluginConstructor[],
	): ServiceInternalTestHarness {
		if (typeof value === 'function') stagePlugin(value)
		else for (const plugin of value) stagePlugin(plugin)
		return harness
	}
	function remove(target: ServiceInternalTestTarget): ServiceInternalTestHarness
	function remove(targets: readonly ServiceInternalTestTarget[]): ServiceInternalTestHarness
	function remove(
		value: ServiceInternalTestTarget | readonly ServiceInternalTestTarget[],
	): ServiceInternalTestHarness {
		for (const target of Array.isArray(value) ? value : [value as ServiceInternalTestTarget]) {
			const address = targetAddress(target)
			if (address.variant === 'fork') {
				stageState(
					{ type: 'remove-node-policy', node: address },
					{
						type: 'remove-fork',
						definition: address.definition,
						forkId: address.forkId,
					},
				)
				continue
			}
			const key = pluginDefinitionIndexKey(address.definition)
			if (draftEntries.delete(key)) catalogDirty = true
		}
		return harness
	}

	const commit = async (allowFailure: boolean): Promise<CommitSummary> => {
		const currentCatalog = coordinator.catalogSnapshot()
		const catalog = catalogDirty
			? createPluginCatalogSnapshot(currentCatalog.revision + 1, draftEntries.values())
			: undefined
		const coldBoot = firstCommit
		const report = await coordinator.update({
			...(catalog ? { catalog } : {}),
			...(stateOperations.length > 0 ? { statePatch: hostStatePatch(...stateOperations) } : {}),
			...(lifecycleCommands.length > 0 ? { lifecycleCommands } : {}),
			...(retryStartNodes.length > 0 ? { retryStartNodes } : {}),
			...(restartNodes.length > 0 ? { restartNodes } : {}),
			reason: 'service-internal-test',
			mode: coldBoot ? 'cold-boot' : 'live',
		})
		firstCommit = false
		committedEntries = new Map(draftEntries)
		draftEntries = new Map(committedEntries)
		catalogDirty = false
		stateOperations = []
		lifecycleCommands = []
		retryStartNodes = []
		restartNodes = []
		if (coldBoot && !allowFailure && report.reconciliation.length > 0) {
			throw new PluginGraphRejectedError(report.reconciliation)
		}

		const summary =
			report.core.status === 'committed'
				? report.core.summary
				: assertCoreCommit(
						await pluginService
							.beginUpdate({ reason: 'service-internal-test-lifecycle-retry' })
							.commit(),
						pluginService,
					)
		if (!allowFailure) assertCommitStarted(summary)
		return summary
	}

	const get = (target: ServiceInternalTestTarget): BasePlugin | undefined =>
		pluginService.getInstance(targetAddress(target))
	const requirePlugin = (target: ServiceInternalTestTarget): BasePlugin => {
		const instance = get(target)
		if (!instance) throw new Error('Plugin instance is not running')
		return instance
	}
	const dispose = (): Promise<void> => {
		if (disposal) return disposal
		disposal = (async () => {
			const errors: unknown[] = []
			try {
				await closeOwnerInvocations(ctx.root)
			} catch (error) {
				errors.push(error)
			}
			try {
				const current = coordinator.catalogSnapshot()
				if (current.entries.length > 0) {
					await coordinator.update({
						catalog: createPluginCatalogSnapshot(current.revision + 1, []),
						reason: 'service-internal-test-dispose',
						mode: 'live',
					})
				}
			} catch (error) {
				errors.push(error)
			}
			try {
				await application.close()
			} catch (error) {
				errors.push(error)
			}
			if (errors.length > 0) {
				throw new AggregateError(
					errors,
					'[pluxel/test] Service internal test harness disposal failed',
				)
			}
		})()
		return disposal
	}

	const internalHarness: ServiceInternalTestHarness = Object.freeze({
		ctx,
		root: ctx,
		pluginService,
		configService,
		coordinator,
		stateStore,
		fetch: async (request: Request): Promise<Response> => {
			const { HttpServer } = await import('../http')
			return resolveContextCapability(ctx, HttpServer).fetch(request)
		},
		add,
		remove,
		start: (target: ServiceInternalTestTarget): ServiceInternalTestHarness => {
			const address = targetAddress(target)
			lifecycleCommands.push({ address, desiredState: 'running' })
			retryStartNodes.push(address)
			return harness
		},
		stop: (target: ServiceInternalTestTarget): ServiceInternalTestHarness => {
			lifecycleCommands.push({ address: targetAddress(target), desiredState: 'stopped' })
			return harness
		},
		restart: (target: ServiceInternalTestTarget): ServiceInternalTestHarness => {
			restartNodes.push(targetAddress(target))
			return harness
		},
		replace: (
			target: ServiceInternalTestTarget,
			next: PluginConstructor,
		): ServiceInternalTestHarness => {
			const definition = targetAddress(target).definition
			const candidate = candidateFor(next)
			if (
				pluginDefinitionIndexKey(candidate.declaration.address) !==
				pluginDefinitionIndexKey(definition)
			) {
				throw new TypeError(
					'Service internal test replacement must be lowered with the target Plugin definition address',
				)
			}
			draftEntries.set(pluginDefinitionIndexKey(definition), Object.freeze({ candidate }))
			catalogDirty = true
			return harness
		},
		fork: <TPlugin extends PluginConstructor>(
			plugin: TPlugin,
			forkId: string,
		): PluginNodeHandle<TPlugin> => {
			stagePlugin(plugin)
			const address = Object.freeze({
				definition: definitionAddress(plugin),
				variant: 'fork' as const,
				forkId,
			}) as PluginNodeHandle<TPlugin>
			stageState({ type: 'ensure-fork', definition: address.definition, forkId })
			return address
		},
		override: (
			consumer: ServiceInternalTestTarget,
			requirement: PluginConstructor | PluginDefinitionAddress,
			provider: PluginNodeAddress | null,
		): ServiceInternalTestHarness => {
			stageState({
				type: 'set-dependency-override',
				consumer: targetAddress(consumer),
				requirement:
					typeof requirement === 'function' ? definitionAddress(requirement) : requirement,
				provider,
			})
			return harness
		},
		commit: () => commit(false),
		commitAllowFail: () => commit(true),
		isRunning: (target: ServiceInternalTestTarget): boolean =>
			pluginService.isRunning(targetAddress(target)),
		get: get as ServiceInternalTestHarness['get'],
		require: requirePlugin as ServiceInternalTestHarness['require'],
		cfg: (<TPlugin extends PluginConstructor>(
			target: TypedTarget<TPlugin>,
		): ServiceInternalTestConfigHandle<TPlugin> => {
			const owner = targetAddress(target)
			return {
				owner,
				set: (patch) => configService.patchConfig(owner, patch),
				unset: (...keys) => configService.unsetConfigKeys(owner, keys),
				rev: () => configService.getConfigRevision(owner),
				setAutoStart: (autoStart) => stageState({ type: 'set-auto-start', node: owner, autoStart }),
				autoStart: () =>
					isPluginAutoStartEnabled(
						applyHostStatePatch(stateStore.snapshot(), hostStatePatch(...stateOperations)),
						owner,
					),
			}
		}) as ServiceInternalTestHarness['cfg'],
		plugins: () => [...draftEntries.values()].map((entry) => entry.candidate.implementation),
		dispose,
		[Symbol.asyncDispose]: dispose,
	})
	harness = internalHarness
	return internalHarness
}

/** Creates a raw Host root for framework service tests without a Plugin transaction harness. */
export async function createServiceInternalTestContext(
	config: ServiceInternalTestHostOptions = {},
	rootOptions: ServiceInternalTestRootOptions = {},
): Promise<ServiceInternalTestContext> {
	const application = await createServiceTestApplication(config, rootOptions)
	const ctx = application.ctx
	const pluginService = requirePluginService(ctx)
	requirePluginHostCoordinator(ctx)
	let disposal: Promise<void> | undefined
	const dispose = (): Promise<void> => {
		if (disposal) return disposal
		disposal = (async () => {
			const errors: unknown[] = []
			try {
				await closeOwnerInvocations(ctx.root)
			} catch (error) {
				errors.push(error)
			}
			try {
				pluginService.resetDraft()
			} catch (error) {
				errors.push(error)
			}
			try {
				await application.close()
			} catch (error) {
				errors.push(error)
			}
			if (errors.length > 0) {
				throw new AggregateError(
					errors,
					'[pluxel/test] Service internal test context disposal failed',
				)
			}
		})()
		return disposal
	}
	return Object.freeze({ ctx, root: ctx, dispose, [Symbol.asyncDispose]: dispose })
}

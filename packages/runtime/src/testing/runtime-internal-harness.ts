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
import type { RuntimeHostConfig } from '../context/runtime-contract'
import { requireRuntimeHttpService } from '../context/runtime-http-capability'
import { prepareRuntimeRootContext } from '../context/runtime-plan'
import {
	applyRuntimeStatePatch,
	createPluginRouteCatalogSnapshot,
	installRuntimePluginGraphCoordinator,
	PluginGraphRejectedError,
	runtimeStatePatch,
	type PluginRouteCatalogEntryInput,
	type RuntimePluginGraphCoordinator,
	type RuntimeStatePatchOperation,
} from '../internal/reconciliation'
import { requireRuntimeStateStore } from '../internal/runtime-state'
import { isPluginAutoStartEnabled } from '../runtime-state'
import type { RuntimeStateStore } from '../services/RuntimeStateStore'
import { createRuntimeTestRoot, type RuntimeInternalTestRootOptions } from './runtime-root'

/** A raw Runtime catalog/lifecycle target for framework-owned white-box tests. */
export type RuntimeInternalTestTarget = PluginConstructor | PluginNodeAddress

type TypedTarget<TPlugin extends PluginConstructor> = TPlugin | PluginNodeHandle<TPlugin>

/** Runtime's internal config handle extends Core's raw config mutation with staged policy. */
export type RuntimeInternalTestConfigHandle<TPlugin extends PluginConstructor> =
	CoreHostConfigHandle<TPlugin> & {
		setAutoStart(autoStart: boolean): void
		autoStart(): boolean
	}

/**
 * Privileged Runtime test authority.
 *
 * This deliberately preserves the legacy staged transaction model for framework protocol
 * suites. Plugin-author tests must use `createRuntimeTestHost()` from `@pluxel/runtime/test`.
 */
export interface RuntimeInternalTestHarness extends AsyncDisposable {
	readonly ctx: RootContext
	readonly root: RootContext
	readonly pluginService: PluginService
	readonly configService: ReturnType<typeof requireConfigService>
	readonly coordinator: RuntimePluginGraphCoordinator<CommitSummary>
	readonly runtimeStateStore: RuntimeStateStore
	fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>
	add(plugin: PluginConstructor): RuntimeInternalTestHarness
	add(plugins: readonly PluginConstructor[]): RuntimeInternalTestHarness
	remove(target: RuntimeInternalTestTarget): RuntimeInternalTestHarness
	remove(targets: readonly RuntimeInternalTestTarget[]): RuntimeInternalTestHarness
	start(target: RuntimeInternalTestTarget): RuntimeInternalTestHarness
	stop(target: RuntimeInternalTestTarget): RuntimeInternalTestHarness
	restart(target: RuntimeInternalTestTarget): RuntimeInternalTestHarness
	replace(target: RuntimeInternalTestTarget, next: PluginConstructor): RuntimeInternalTestHarness
	fork<TPlugin extends PluginConstructor>(
		plugin: TPlugin,
		forkId: string,
	): PluginNodeHandle<TPlugin>
	override(
		consumer: RuntimeInternalTestTarget,
		requirement: PluginConstructor | PluginDefinitionAddress,
		provider: PluginNodeAddress | null,
	): RuntimeInternalTestHarness
	commit(): Promise<CommitSummary>
	commitAllowFail(): Promise<CommitSummary>
	isRunning(target: RuntimeInternalTestTarget): boolean
	get<TPlugin extends PluginConstructor>(
		target: TypedTarget<TPlugin>,
	): InstanceType<TPlugin> | undefined
	get(target: PluginNodeAddress): BasePlugin | undefined
	require<TPlugin extends PluginConstructor>(target: TypedTarget<TPlugin>): InstanceType<TPlugin>
	require(target: PluginNodeAddress): BasePlugin
	cfg<TPlugin extends PluginConstructor>(
		target: TypedTarget<TPlugin>,
	): RuntimeInternalTestConfigHandle<TPlugin>
	plugins(): PluginConstructor[]
	dispose(): Promise<void>
}

/** Root-only authority for Runtime service tests that do not need a staged catalog. */
export interface RuntimeInternalTestContext extends AsyncDisposable {
	readonly ctx: RootContext
	readonly root: RootContext
	dispose(): Promise<void>
}

function normalizeRuntimeInternalTestConfig(config: RuntimeHostConfig): RuntimeHostConfig {
	return {
		...config,
		...(Object.hasOwn(config, 'name') ? {} : { name: 'test' }),
		...(Object.hasOwn(config, 'persistence') ? {} : { persistence: { mode: 'memory' } }),
		...(Object.hasOwn(config, 'configService') ? {} : { configService: { mode: 'memory' } }),
		...(Object.hasOwn(config, 'runtimeState') ? {} : { runtimeState: { mode: 'memory' } }),
		// Legacy privileged Workbench tests create their raw host without an opt-in.
		workbench: config.workbench ?? { enabled: true },
	}
}

function assertCoreCommit(
	result: Awaited<ReturnType<ReturnType<PluginService['beginUpdate']>['commit']>>,
	pluginService: PluginService,
): CommitSummary {
	if (result.ok === false) {
		throw result.err instanceof Error ? result.err : new Error(String(result.err))
	}
	const summary = pluginService.lastCommit
	if (!summary) throw new Error('Runtime internal test Core commit omitted CommitSummary')
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
 * Creates the Runtime framework's raw staged test harness.
 *
 * It owns the Runtime coordinator transaction directly; do not compose a Core internal host
 * here because that would introduce a competing catalog/lifecycle transaction model.
 */
export function createRuntimeInternalTestHarness(
	config: RuntimeHostConfig = {},
	rootOptions: RuntimeInternalTestRootOptions = {},
): RuntimeInternalTestHarness {
	const ctx = createRuntimeTestRoot(normalizeRuntimeInternalTestConfig(config), rootOptions)
	const pluginService = requirePluginService(ctx)
	const configService = requireConfigService(ctx)
	const runtimeStateStore = requireRuntimeStateStore(ctx)
	const coordinator = installRuntimePluginGraphCoordinator(ctx)

	const addressByImplementation = new WeakMap<PluginConstructor, PluginDefinitionAddress>()
	let committedEntries = new Map<string, PluginRouteCatalogEntryInput>()
	let draftEntries = new Map(committedEntries)
	let catalogDirty = false
	let stateOperations: RuntimeStatePatchOperation[] = []
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
	const targetAddress = (target: RuntimeInternalTestTarget): PluginNodeAddress =>
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
	const stageState = (...operations: readonly RuntimeStatePatchOperation[]): void => {
		stateOperations.push(...operations)
	}

	let harness!: RuntimeInternalTestHarness
	function add(plugin: PluginConstructor): RuntimeInternalTestHarness
	function add(plugins: readonly PluginConstructor[]): RuntimeInternalTestHarness
	function add(
		value: PluginConstructor | readonly PluginConstructor[],
	): RuntimeInternalTestHarness {
		if (typeof value === 'function') stagePlugin(value)
		else for (const plugin of value) stagePlugin(plugin)
		return harness
	}
	function remove(target: RuntimeInternalTestTarget): RuntimeInternalTestHarness
	function remove(targets: readonly RuntimeInternalTestTarget[]): RuntimeInternalTestHarness
	function remove(
		value: RuntimeInternalTestTarget | readonly RuntimeInternalTestTarget[],
	): RuntimeInternalTestHarness {
		for (const target of Array.isArray(value) ? value : [value as RuntimeInternalTestTarget]) {
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
		await prepareRuntimeRootContext(ctx)
		const currentCatalog = coordinator.catalogSnapshot()
		const catalog = catalogDirty
			? createPluginRouteCatalogSnapshot(currentCatalog.revision + 1, draftEntries.values())
			: undefined
		const coldBoot = firstCommit
		const report = await coordinator.update({
			...(catalog ? { catalog } : {}),
			...(stateOperations.length > 0 ? { statePatch: runtimeStatePatch(...stateOperations) } : {}),
			...(lifecycleCommands.length > 0 ? { lifecycleCommands } : {}),
			...(retryStartNodes.length > 0 ? { retryStartNodes } : {}),
			...(restartNodes.length > 0 ? { restartNodes } : {}),
			reason: 'runtime-internal-test',
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
							.beginUpdate({ reason: 'runtime-internal-test-lifecycle-retry' })
							.commit(),
						pluginService,
					)
		if (!allowFailure) assertCommitStarted(summary)
		return summary
	}

	const get = (target: RuntimeInternalTestTarget): BasePlugin | undefined =>
		pluginService.getInstance(targetAddress(target))
	const requirePlugin = (target: RuntimeInternalTestTarget): BasePlugin => {
		const instance = get(target)
		if (!instance) throw new Error('Plugin instance is not running')
		return instance
	}
	const dispose = (): Promise<void> => {
		if (disposal) return disposal
		disposal = (async () => {
			const errors: unknown[] = []
			try {
				const current = coordinator.catalogSnapshot()
				if (current.entries.length > 0) {
					await coordinator.update({
						catalog: createPluginRouteCatalogSnapshot(current.revision + 1, []),
						reason: 'runtime-internal-test-dispose',
						mode: 'live',
					})
				}
			} catch (error) {
				errors.push(error)
			}
			try {
				await ctx.effects.dispose()
			} catch (error) {
				errors.push(error)
			}
			if (errors.length > 0) {
				throw new AggregateError(
					errors,
					'[pluxel/test] Runtime internal test harness disposal failed',
				)
			}
		})()
		return disposal
	}

	const internalHarness: RuntimeInternalTestHarness = Object.freeze({
		ctx,
		root: ctx,
		pluginService,
		configService,
		coordinator,
		runtimeStateStore,
		fetch: (
			request: Request,
			env?: unknown,
			fetchContext?: unknown,
		): Response | Promise<Response> =>
			requireRuntimeHttpService(ctx).fetch(request, env, fetchContext),
		add,
		remove,
		start: (target: RuntimeInternalTestTarget): RuntimeInternalTestHarness => {
			const address = targetAddress(target)
			lifecycleCommands.push({ address, desiredState: 'running' })
			retryStartNodes.push(address)
			return harness
		},
		stop: (target: RuntimeInternalTestTarget): RuntimeInternalTestHarness => {
			lifecycleCommands.push({ address: targetAddress(target), desiredState: 'stopped' })
			return harness
		},
		restart: (target: RuntimeInternalTestTarget): RuntimeInternalTestHarness => {
			restartNodes.push(targetAddress(target))
			return harness
		},
		replace: (
			target: RuntimeInternalTestTarget,
			next: PluginConstructor,
		): RuntimeInternalTestHarness => {
			const definition = targetAddress(target).definition
			const candidate = candidateFor(next)
			if (
				pluginDefinitionIndexKey(candidate.declaration.address) !==
				pluginDefinitionIndexKey(definition)
			) {
				throw new TypeError(
					'Runtime internal test replacement must be lowered with the target Plugin definition address',
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
			consumer: RuntimeInternalTestTarget,
			requirement: PluginConstructor | PluginDefinitionAddress,
			provider: PluginNodeAddress | null,
		): RuntimeInternalTestHarness => {
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
		isRunning: (target: RuntimeInternalTestTarget): boolean =>
			pluginService.isRunning(targetAddress(target)),
		get: get as RuntimeInternalTestHarness['get'],
		require: requirePlugin as RuntimeInternalTestHarness['require'],
		cfg: (<TPlugin extends PluginConstructor>(
			target: TypedTarget<TPlugin>,
		): RuntimeInternalTestConfigHandle<TPlugin> => {
			const owner = targetAddress(target)
			return {
				owner,
				set: (patch) => configService.patchConfig(owner, patch),
				unset: (...keys) => configService.unsetConfigKeys(owner, keys),
				rev: () => configService.getConfigRevision(owner),
				setAutoStart: (autoStart) => stageState({ type: 'set-auto-start', node: owner, autoStart }),
				autoStart: () =>
					isPluginAutoStartEnabled(
						applyRuntimeStatePatch(
							runtimeStateStore.snapshot(),
							runtimeStatePatch(...stateOperations),
						),
						owner,
					),
			}
		}) as RuntimeInternalTestHarness['cfg'],
		plugins: () => [...draftEntries.values()].map((entry) => entry.candidate.implementation),
		dispose,
		[Symbol.asyncDispose]: dispose,
	})
	harness = internalHarness
	return internalHarness
}

/** Creates a raw Runtime root for framework service tests without a Plugin transaction harness. */
export function createRuntimeInternalTestContext(
	config: RuntimeHostConfig = {},
	rootOptions: RuntimeInternalTestRootOptions = {},
): RuntimeInternalTestContext {
	const ctx = createRuntimeTestRoot(normalizeRuntimeInternalTestConfig(config), rootOptions)
	const pluginService = requirePluginService(ctx)
	installRuntimePluginGraphCoordinator(ctx)
	let disposal: Promise<void> | undefined
	const dispose = (): Promise<void> => {
		if (disposal) return disposal
		disposal = (async () => {
			const errors: unknown[] = []
			try {
				pluginService.resetDraft()
			} catch (error) {
				errors.push(error)
			}
			try {
				await ctx.effects.dispose()
			} catch (error) {
				errors.push(error)
			}
			if (errors.length > 0) {
				throw new AggregateError(
					errors,
					'[pluxel/test] Runtime internal test context disposal failed',
				)
			}
		})()
		return disposal
	}
	return Object.freeze({ ctx, root: ctx, dispose, [Symbol.asyncDispose]: dispose })
}

import {
	pluginDefinitionAddressEqual,
	pluginDefinitionAddressOf,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
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
	collectPluginTestDraft,
	projectPluginTestCommitSummary,
	resolvePluginTestTarget,
	type PluginTestDraftAuthority,
} from '@pluxel/core/internal/test'
import { validateConfigRecord } from '@pluxel/core/services'
import {
	PluginLifecycleAssertionError,
	type DependencyOverrideInput,
	type DependencyOverrideTarget,
	type LifecycleFailureCommitSummary,
	type PluginConstructor,
	type PluginForkRef,
	type PluginInitialConfigOptions,
	type PluginInstanceFor,
	type PluginInstances,
	type PluginLifecycleAssertionOperation,
	type PluginTestCommitSummary,
	type PluginTestTarget,
	type PluginToken,
	type ProviderDefaultInput,
	type RawPluginConfig,
} from '@pluxel/core/test'
import { removeFork } from '../api/usecases/pluginForks'
import type { RuntimeHostConfig } from '../context/runtime-contract'
import { prepareRuntimeRootContext } from '../context/runtime-plan'
import {
	createPluginRouteCatalogSnapshot,
	installRuntimePluginGraphCoordinator,
	PluginGraphRejectedError,
	PluginRestartUnavailableError,
	PluginStartUnavailableError,
	RuntimeStateMutationRejectedError,
	runtimeStatePatch,
	type PluginApplyReport,
	type PluginRouteCatalogEntryInput,
	type RuntimePluginGraphCoordinator,
	type RuntimeStatePatchOperation,
} from '../internal/reconciliation'
import { requireRuntimeStateStore } from '../internal/runtime-state'
import type { RuntimeStateStore } from '../services/RuntimeStateStore'
import type {
	RuntimeCommandsTestDriver,
	RuntimeConfigTestDriver,
	RuntimeHttpTestDriver,
	RuntimeWorkbenchTestDriver,
} from './contracts'
import { createRuntimeTestDriverScope } from './driver-scope'
import { createRuntimeTestRoot, type RuntimeInternalTestRootOptions } from './runtime-root'

export type RuntimePluginStartOptions = PluginInitialConfigOptions &
	Readonly<{
		/** Concrete candidates made available to production dependency resolution. */
		catalog?: readonly PluginConstructor[]
	}>

export type RuntimePluginBatchStartOptions = Readonly<{
	/** Concrete candidates made available to production dependency resolution. */
	catalog?: readonly PluginConstructor[]
}>

export interface RuntimePluginTestChange {
	start(target: PluginTestTarget, options?: RuntimePluginStartOptions): undefined
	start(targets: readonly PluginTestTarget[], options?: RuntimePluginBatchStartOptions): undefined
	stop(target: PluginTestTarget): undefined
	restart(target: PluginTestTarget): undefined
	replaceDefinition(current: PluginConstructor, next: PluginConstructor): undefined
	readonly catalog: {
		add(plugins: PluginConstructor | readonly PluginConstructor[]): undefined
		remove(plugins: PluginConstructor | readonly PluginConstructor[]): undefined
	}
	readonly forks: {
		ensure<TPlugin extends PluginConstructor>(
			target: PluginForkRef<TPlugin>,
			options?: PluginInitialConfigOptions,
		): undefined
		remove<TPlugin extends PluginConstructor>(target: PluginForkRef<TPlugin>): undefined
	}
	readonly config: {
		seed(target: PluginTestTarget, value: RawPluginConfig): undefined
	}
	readonly dependencies: {
		setDefault(input: ProviderDefaultInput): undefined
		clearDefault(requirement: PluginToken): undefined
		setOverride(input: DependencyOverrideInput): undefined
		clearOverride(input: DependencyOverrideTarget): undefined
	}
}

export interface RuntimeTestHost extends AsyncDisposable {
	readonly config: RuntimeConfigTestDriver
	readonly http: RuntimeHttpTestDriver
	readonly commands: RuntimeCommandsTestDriver
	readonly workbench: RuntimeWorkbenchTestDriver
	start<TTarget extends PluginTestTarget>(
		target: TTarget,
		options?: RuntimePluginStartOptions,
	): Promise<PluginInstanceFor<TTarget>>
	start<const TTargets extends readonly PluginTestTarget[]>(
		targets: TTargets,
		options?: RuntimePluginBatchStartOptions,
	): Promise<PluginInstances<TTargets>>
	stop(target: PluginTestTarget): Promise<void>
	restart<TTarget extends PluginTestTarget>(target: TTarget): Promise<PluginInstanceFor<TTarget>>
	replaceDefinition(current: PluginConstructor, next: PluginConstructor): Promise<void>
	commit(build: (change: RuntimePluginTestChange) => undefined): Promise<void>
	commitExpectFail(
		build: (change: RuntimePluginTestChange) => undefined,
	): Promise<LifecycleFailureCommitSummary>
	require<TTarget extends PluginTestTarget>(target: TTarget): PluginInstanceFor<TTarget>
	isRunning(target: PluginTestTarget): boolean
	dispose(): Promise<void>
}

/** `plugins` tunes lifecycle execution; constructor availability belongs to start/catalog. */
export type RuntimeTestHostConfig = Pick<
	RuntimeHostConfig,
	| 'name'
	| 'logger'
	| 'events'
	| 'plugins'
	| 'persistence'
	| 'database'
	| 'workers'
	| 'management'
	| 'workbench'
	| 'vault'
>

/** @internal Framework-only host authority; absent from `@pluxel/runtime/test`. */
export interface RuntimeInternalTestHost extends RuntimeTestHost {
	readonly ctx: RootContext
	readonly root: RootContext
	readonly pluginService: PluginService
	readonly configService: ReturnType<typeof requireConfigService>
	readonly coordinator: RuntimePluginGraphCoordinator<CommitSummary>
	readonly runtimeStateStore: RuntimeStateStore
}

type CatalogCommand = Readonly<{
	plugin: PluginConstructor
	candidate: ConcretePluginDefinitionCandidate
}>

type TargetCommand = Readonly<{
	target: PluginTestTarget
	address: PluginNodeAddress
	implementation: PluginConstructor
}>

type ReplacementCommand = Readonly<{
	current: PluginConstructor
	next: PluginConstructor
	definition: PluginDefinitionAddress
	candidate: ConcretePluginDefinitionCandidate
}>

type DefaultCommand =
	| Readonly<{ kind: 'set'; requirement: PluginToken; provider: PluginConstructor }>
	| Readonly<{ kind: 'clear'; requirement: PluginToken }>

type OverrideCommand =
	| Readonly<{
			kind: 'set'
			consumer: PluginTestTarget
			requirement: PluginToken
			provider: PluginTestTarget
	  }>
	| Readonly<{
			kind: 'clear'
			consumer: PluginTestTarget
			requirement: PluginToken
	  }>

type RuntimeDraftPlan = {
	readonly starts: Map<string, TargetCommand>
	readonly stops: Map<string, TargetCommand>
	readonly restarts: Map<string, TargetCommand>
	readonly catalogAdds: Map<string, CatalogCommand>
	readonly catalogRemoves: Map<string, CatalogCommand>
	readonly forkEnsures: Map<string, TargetCommand>
	readonly forkRemoves: Map<string, TargetCommand>
	readonly replacements: Map<string, ReplacementCommand>
	readonly seeds: Map<string, Readonly<{ target: PluginTestTarget; values: RawPluginConfig[] }>>
	readonly defaults: Map<string, DefaultCommand>
	readonly overrides: Map<string, OverrideCommand>
	readonly targets: Map<string, PluginTestTarget>
}

type PreparedSeed = Readonly<{
	key: string
	address: PluginNodeAddress
	authority: NonNullable<ConcretePluginDefinitionCandidate['declaration']['config']>
	value: Readonly<Record<string, unknown>>
}>

type RawCommit = Readonly<{
	summary: PluginTestCommitSummary
	targets: readonly PluginTestTarget[]
}>

const EMPTY_TEST_SUMMARY: PluginTestCommitSummary = Object.freeze({
	lifecycleReport: Object.freeze({ ok: true, issues: Object.freeze([]) }),
})

/** Create an isolated Runtime Plugin world without starting or materializing a Plugin. */
export function createRuntimeTestHost(config: RuntimeTestHostConfig = {}): RuntimeTestHost {
	return createRuntimeHostWorld(config, {}, true).host
}

/** @internal Create the same world with explicit root/service authority. */
export function createRuntimeInternalTestHost(
	config: RuntimeHostConfig = {},
	options: RuntimeInternalTestRootOptions = {},
): RuntimeInternalTestHost {
	return createRuntimeHostWorld(config, options).internalHost
}

function createPlan(): RuntimeDraftPlan {
	return {
		starts: new Map(),
		stops: new Map(),
		restarts: new Map(),
		catalogAdds: new Map(),
		catalogRemoves: new Map(),
		forkEnsures: new Map(),
		forkRemoves: new Map(),
		replacements: new Map(),
		seeds: new Map(),
		defaults: new Map(),
		overrides: new Map(),
		targets: new Map(),
	}
}

function createChange(
	plan: RuntimeDraftPlan,
	authority: PluginTestDraftAuthority,
): RuntimePluginTestChange {
	const recordTarget = (target: PluginTestTarget): TargetCommand => {
		authority.assertActive('Plugin target command')
		const resolved = resolvePluginTestTarget(target)
		const key = pluginNodeIndexKey(resolved.address)
		plan.targets.set(key, target)
		return Object.freeze({
			target,
			address: resolved.address,
			implementation: resolved.implementation,
		})
	}

	const addCatalogOne = (plugin: PluginConstructor): void => {
		const candidate = consumePluginDefinitionCandidate(plugin)
		const key = pluginDefinitionIndexKey(candidate.declaration.address)
		if (plan.catalogRemoves.has(key)) throw conflictError('catalog.add/catalog.remove', plugin)
		if (plan.replacements.has(key)) throw conflictError('catalog.add/replaceDefinition', plugin)
		const previous = plan.catalogAdds.get(key)
		if (previous && previous.plugin !== plugin) {
			throw conflictError('catalog.add', plugin, 'two implementations use one definition address')
		}
		plan.catalogAdds.set(key, Object.freeze({ plugin, candidate }))
	}

	const recordSeed = (target: PluginTestTarget, value: RawPluginConfig): void => {
		const command = recordTarget(target)
		const key = pluginNodeIndexKey(command.address)
		assertNoReplacementConflict(plan, command.address.definition, 'config.seed')
		const snapshot = snapshotRawConfig(value)
		const current = plan.seeds.get(key)
		if (current) current.values.push(snapshot)
		else plan.seeds.set(key, { target, values: [snapshot] })
	}

	const startOne = (
		target: PluginTestTarget,
		options: RuntimePluginStartOptions | undefined,
	): void => {
		const command = recordTarget(target)
		const key = pluginNodeIndexKey(command.address)
		assertNoTargetLifecycleConflict(plan, key, 'start')
		assertNoReplacementConflict(plan, command.address.definition, 'start')
		addCatalogOne(command.implementation)
		if (command.address.variant === 'fork') plan.forkEnsures.set(key, command)
		plan.starts.set(key, command)
		for (const plugin of options?.catalog ?? []) addCatalogOne(plugin)
		if (options?.initialConfig !== undefined) recordSeed(target, options.initialConfig)
	}

	function start(target: PluginTestTarget, options?: RuntimePluginStartOptions): undefined
	function start(
		targets: readonly PluginTestTarget[],
		options?: RuntimePluginBatchStartOptions,
	): undefined
	function start(
		input: PluginTestTarget | readonly PluginTestTarget[],
		options?: RuntimePluginStartOptions,
	): undefined {
		authority.recordCommand('change.start()')
		if (Array.isArray(input)) {
			if (Object.hasOwn(options ?? {}, 'initialConfig')) {
				throw new TypeError('[pluxel/test] batch start() does not accept initialConfig')
			}
			assertNonEmptyUniqueTargets(input, 'change.start()')
			for (const target of input) startOne(target, options)
		} else {
			startOne(input as PluginTestTarget, options)
		}
		return undefined
	}

	const stop = (target: PluginTestTarget): undefined => {
		authority.recordCommand('change.stop()')
		const command = recordTarget(target)
		const key = pluginNodeIndexKey(command.address)
		assertNoTargetLifecycleConflict(plan, key, 'stop')
		assertNoReplacementConflict(plan, command.address.definition, 'stop')
		plan.stops.set(key, command)
		return undefined
	}

	const restart = (target: PluginTestTarget): undefined => {
		authority.recordCommand('change.restart()')
		const command = recordTarget(target)
		const key = pluginNodeIndexKey(command.address)
		assertNoTargetLifecycleConflict(plan, key, 'restart')
		assertNoReplacementConflict(plan, command.address.definition, 'restart')
		plan.restarts.set(key, command)
		return undefined
	}

	const replaceDefinition = (current: PluginConstructor, next: PluginConstructor): undefined => {
		authority.recordCommand('change.replaceDefinition()')
		const currentResolved = resolvePluginTestTarget(current)
		const candidate = consumePluginDefinitionCandidate(next)
		if (
			!pluginDefinitionAddressEqual(
				currentResolved.address.definition,
				candidate.declaration.address,
			)
		) {
			throw new TypeError(
				'[pluxel/test] replaceDefinition() constructors must have the same canonical definition address',
			)
		}
		const definition = currentResolved.address.definition
		assertDefinitionHasNoCommands(plan, definition, 'replaceDefinition')
		const key = pluginDefinitionIndexKey(definition)
		const previous = plan.replacements.get(key)
		if (previous && (previous.current !== current || previous.next !== next)) {
			throw conflictError('replaceDefinition', current, 'two different replacements')
		}
		plan.replacements.set(key, Object.freeze({ current, next, definition, candidate }))
		plan.targets.set(pluginNodeIndexKey(currentResolved.address), current)
		return undefined
	}

	const catalogAdd = (input: PluginConstructor | readonly PluginConstructor[]): undefined => {
		authority.recordCommand('change.catalog.add()')
		const values = typeof input === 'function' ? [input] : input
		assertNonEmpty(values, 'change.catalog.add()')
		for (const plugin of values) addCatalogOne(plugin)
		return undefined
	}

	const catalogRemove = (input: PluginConstructor | readonly PluginConstructor[]): undefined => {
		authority.recordCommand('change.catalog.remove()')
		const values = typeof input === 'function' ? [input] : input
		assertNonEmpty(values, 'change.catalog.remove()')
		for (const plugin of values) {
			const candidate = consumePluginDefinitionCandidate(plugin)
			const key = pluginDefinitionIndexKey(candidate.declaration.address)
			if (plan.catalogAdds.has(key)) throw conflictError('catalog.add/catalog.remove', plugin)
			assertDefinitionHasNoCommands(plan, candidate.declaration.address, 'catalog.remove')
			plan.catalogRemoves.set(key, Object.freeze({ plugin, candidate }))
		}
		return undefined
	}

	const forkEnsure = <TPlugin extends PluginConstructor>(
		target: PluginForkRef<TPlugin>,
		options: PluginInitialConfigOptions = {},
	): undefined => {
		authority.recordCommand('change.forks.ensure()')
		const command = recordTarget(target)
		if (command.address.variant !== 'fork') {
			throw new TypeError('[pluxel/test] forks.ensure() requires definePluginFork()')
		}
		const key = pluginNodeIndexKey(command.address)
		if (plan.forkRemoves.has(key)) throw conflictError('forks.ensure/forks.remove', target)
		assertNoReplacementConflict(plan, command.address.definition, 'forks.ensure')
		plan.forkEnsures.set(key, command)
		if (options.initialConfig !== undefined) recordSeed(target, options.initialConfig)
		return undefined
	}

	const forkRemove = <TPlugin extends PluginConstructor>(
		target: PluginForkRef<TPlugin>,
	): undefined => {
		authority.recordCommand('change.forks.remove()')
		const command = recordTarget(target)
		if (command.address.variant !== 'fork') {
			throw new TypeError('[pluxel/test] forks.remove() requires definePluginFork()')
		}
		const key = pluginNodeIndexKey(command.address)
		if (plan.forkEnsures.has(key)) throw conflictError('forks.ensure/forks.remove', target)
		plan.forkRemoves.set(key, command)
		return undefined
	}

	const seed = (target: PluginTestTarget, value: RawPluginConfig): undefined => {
		authority.recordCommand('change.config.seed()')
		recordSeed(target, value)
		return undefined
	}

	const setDefault = (input: ProviderDefaultInput): undefined => {
		authority.recordCommand('change.dependencies.setDefault()')
		const key = pluginDefinitionIndexKey(pluginDefinitionAddressOf(input.requirement))
		const previous = plan.defaults.get(key)
		if (previous && (previous.kind !== 'set' || previous.provider !== input.provider)) {
			throw conflictError('dependencies.setDefault', input.requirement)
		}
		plan.defaults.set(key, Object.freeze({ kind: 'set', ...input }))
		const provider = resolvePluginTestTarget(input.provider)
		plan.targets.set(pluginNodeIndexKey(provider.address), input.provider)
		return undefined
	}

	const clearDefault = (requirement: PluginToken): undefined => {
		authority.recordCommand('change.dependencies.clearDefault()')
		const key = pluginDefinitionIndexKey(pluginDefinitionAddressOf(requirement))
		const previous = plan.defaults.get(key)
		if (previous && previous.kind !== 'clear') {
			throw conflictError('dependencies.setDefault/clearDefault', requirement)
		}
		plan.defaults.set(key, Object.freeze({ kind: 'clear', requirement }))
		return undefined
	}

	const overrideKey = (input: DependencyOverrideTarget): string => {
		const consumer = resolvePluginTestTarget(input.consumer).address
		return `${pluginNodeIndexKey(consumer)}\0${pluginDefinitionIndexKey(pluginDefinitionAddressOf(input.requirement))}`
	}

	const setOverride = (input: DependencyOverrideInput): undefined => {
		authority.recordCommand('change.dependencies.setOverride()')
		const key = overrideKey(input)
		const previous = plan.overrides.get(key)
		if (
			previous &&
			(previous.kind !== 'set' ||
				!sameTarget(previous.consumer, input.consumer) ||
				!sameTarget(previous.provider, input.provider))
		) {
			throw conflictError('dependencies.setOverride', input.consumer)
		}
		plan.overrides.set(key, Object.freeze({ kind: 'set', ...input }))
		for (const target of [input.consumer, input.provider]) {
			const resolved = resolvePluginTestTarget(target)
			plan.targets.set(pluginNodeIndexKey(resolved.address), target)
		}
		return undefined
	}

	const clearOverride = (input: DependencyOverrideTarget): undefined => {
		authority.recordCommand('change.dependencies.clearOverride()')
		const key = overrideKey(input)
		const previous = plan.overrides.get(key)
		if (previous && previous.kind !== 'clear') {
			throw conflictError('dependencies.setOverride/clearOverride', input.consumer)
		}
		plan.overrides.set(key, Object.freeze({ kind: 'clear', ...input }))
		const resolved = resolvePluginTestTarget(input.consumer)
		plan.targets.set(pluginNodeIndexKey(resolved.address), input.consumer)
		return undefined
	}

	return Object.freeze({
		start,
		stop,
		restart,
		replaceDefinition,
		catalog: Object.freeze({ add: catalogAdd, remove: catalogRemove }),
		forks: Object.freeze({ ensure: forkEnsure, remove: forkRemove }),
		config: Object.freeze({ seed }),
		dependencies: Object.freeze({
			setDefault,
			clearDefault,
			setOverride,
			clearOverride,
		}),
	})
}

function createRuntimeHostWorld(
	config: RuntimeHostConfig,
	rootOptions: RuntimeInternalTestRootOptions = {},
	forceMemoryStores = false,
): Readonly<{ host: RuntimeTestHost; internalHost: RuntimeInternalTestHost }> {
	const ctx = createRuntimeTestRoot(
		normalizeRuntimeTestConfig(config, forceMemoryStores),
		rootOptions,
	)
	const pluginService = requirePluginService(ctx)
	const configService = requireConfigService(ctx)
	const runtimeStateStore = requireRuntimeStateStore(ctx)
	const coordinator = installRuntimePluginGraphCoordinator(ctx)
	const enteredLifecycle = new Set<string>()
	const configuredTargets = new Set<string>()
	let firstCommit = true
	let disposal: Promise<void> | undefined

	const resolveCommittedTarget = (
		target: PluginTestTarget,
		options: { allowAbsent?: boolean } = {},
	): PluginNodeAddress => {
		const resolved = resolvePluginTestTarget(target)
		const entry = coordinator
			.catalogSnapshot()
			.byDefinition.get(pluginDefinitionIndexKey(resolved.address.definition))
		if (!entry) {
			if (options.allowAbsent) return resolved.address
			throw invalidTarget('target', target, 'is not available in the committed Runtime catalog')
		}
		if (entry.candidate.implementation !== resolved.implementation) throw staleTarget(target)
		if (resolved.address.variant === 'fork' && !forkExists(runtimeStateStore, resolved.address)) {
			if (options.allowAbsent) return resolved.address
			throw invalidTarget('target', target, 'fork identity is not present in Runtime state')
		}
		return resolved.address
	}

	const scope = createRuntimeTestDriverScope({ ctx, resolveTarget: resolveCommittedTarget })
	const collect = (build: (change: RuntimePluginTestChange) => undefined): RuntimeDraftPlan =>
		collectPluginTestDraft(build, (authority) => {
			const plan = createPlan()
			return Object.freeze({ change: createChange(plan, authority), plan })
		})

	const commitForkRemoval = async (plan: RuntimeDraftPlan): Promise<RawCommit> => {
		const command = [...plan.forkRemoves.values()][0]!
		const address = command.address
		if (address.variant !== 'fork') throw new TypeError('[pluxel/test] invalid fork removal target')
		const result = await removeFork(
			ctx,
			Object.freeze({ definition: address.definition, variant: 'default' }),
			address.forkId,
		)
		if (result.ok === false) {
			throw Object.assign(
				new Error(`[pluxel/test] forks.remove() failed: ${result.message}`),
				result,
			)
		}
		const summary =
			'report' in result && result.report.core.status === 'committed'
				? projectPluginTestCommitSummary(result.report.core.summary, pluginService)
				: EMPTY_TEST_SUMMARY
		return Object.freeze({ summary, targets: Object.freeze([command.target]) })
	}

	const commitPlan = async (
		plan: RuntimeDraftPlan,
		options: { rejectRunningStartCatalogChange?: boolean } = {},
	): Promise<RawCommit> => {
		assertForkRemoveExclusive(plan)
		await prepareRuntimeRootContext(ctx)
		if (plan.forkRemoves.size > 0) return commitForkRemoval(plan)

		const catalog = buildCatalog(plan, coordinator)
		validatePlan(plan, catalog.entries, pluginService, runtimeStateStore)
		if (
			options.rejectRunningStartCatalogChange &&
			catalog.snapshot &&
			[...plan.starts.values()].some(({ address }) => pluginService.isRunning(address))
		) {
			throw new Error(
				'[pluxel/test] start() cannot change catalog availability for an already-running target; use host.commit(change => ...) explicitly',
			)
		}
		const seeds = await prepareSeeds(
			plan,
			catalog.entries,
			configService,
			enteredLifecycle,
			configuredTargets,
		)
		const tickets: Array<
			Readonly<{
				key: string
				ticket: ReturnType<typeof configService.stageValidatedConfig>
			}>
		> = []
		for (const seed of seeds) {
			tickets.push(
				Object.freeze({
					key: seed.key,
					ticket: configService.stageValidatedConfig({
						owner: seed.address,
						authority: seed.authority,
						expectedRevision: configService.getConfigRevision(seed.address),
						value: seed.value,
					}),
				}),
			)
		}
		if (tickets.length > 0) {
			await configService.flush()
			for (const item of tickets) {
				configService.confirmValidatedConfig(item.ticket)
				configuredTargets.add(item.key)
			}
		}

		const stateOperations = statePatchOperations(plan)
		let report: PluginApplyReport<CommitSummary>
		try {
			report = await coordinator.update({
				...(catalog.snapshot ? { catalog: catalog.snapshot } : {}),
				...(stateOperations.length > 0
					? { statePatch: runtimeStatePatch(...stateOperations) }
					: {}),
				...(plan.starts.size > 0 || plan.stops.size > 0
					? {
							lifecycleCommands: [
								...Array.from(plan.starts.values(), ({ address }) => ({
									address,
									desiredState: 'running' as const,
								})),
								...Array.from(plan.stops.values(), ({ address }) => ({
									address,
									desiredState: 'stopped' as const,
								})),
							],
						}
					: {}),
				...(plan.starts.size > 0
					? { retryStartNodes: Array.from(plan.starts.values(), ({ address }) => address) }
					: {}),
				...(plan.restarts.size > 0
					? { restartNodes: Array.from(plan.restarts.values(), ({ address }) => address) }
					: {}),
				reason: 'runtime-test',
				mode: firstCommit ? 'cold-boot' : 'live',
			})
		} catch (error) {
			if (isPreCommitRejection(error)) {
				await rollbackSeeds(seeds, configService, configuredTargets)
			}
			throw error
		}

		firstCommit = false
		for (const command of plan.starts.values()) {
			enteredLifecycle.add(pluginNodeIndexKey(command.address))
		}
		for (const node of pluginService.readCommittedDependencyAdjacency().nodes) {
			enteredLifecycle.add(pluginNodeIndexKey(node))
		}
		if (report.reconciliation.length > 0 && report.core.status === 'unchanged') {
			throw new PluginGraphRejectedError(report.reconciliation)
		}
		const summary =
			report.core.status === 'committed'
				? projectPluginTestCommitSummary(report.core.summary, pluginService)
				: EMPTY_TEST_SUMMARY
		return Object.freeze({ summary, targets: Object.freeze([...plan.targets.values()]) })
	}

	const assertStrict = (
		operation: PluginLifecycleAssertionOperation,
		commit: RawCommit,
		requiredRunning: readonly PluginTestTarget[] = [],
		requiredStopped: readonly PluginTestTarget[] = [],
	): void => {
		if (
			commit.summary.lifecycleReport.issues.length > 0 ||
			requiredRunning.some((target) => {
				const address = resolveCommittedTarget(target)
				return !pluginService.isRunning(address)
			}) ||
			requiredStopped.some((target) => {
				const address = resolveCommittedTarget(target)
				return pluginService.isRunning(address)
			})
		) {
			throw new PluginLifecycleAssertionError(operation, commit.targets, commit.summary)
		}
	}

	const runBuild = <T>(
		operation: PluginLifecycleAssertionOperation,
		build: (change: RuntimePluginTestChange) => undefined,
		finish: (commit: RawCommit) => T,
	): Promise<T> =>
		scope.runMutation(operation, async () => {
			const committed = await commitPlan(collect(build), {
				rejectRunningStartCatalogChange: operation === 'start',
			})
			return finish(committed)
		})

	function start<TTarget extends PluginTestTarget>(
		target: TTarget,
		options?: RuntimePluginStartOptions,
	): Promise<PluginInstanceFor<TTarget>>
	function start<const TTargets extends readonly PluginTestTarget[]>(
		targets: TTargets,
		options?: RuntimePluginBatchStartOptions,
	): Promise<PluginInstances<TTargets>>
	function start(
		input: PluginTestTarget | readonly PluginTestTarget[],
		options?: RuntimePluginStartOptions,
	): Promise<unknown> {
		const batch = Array.isArray(input)
		const targets = Object.freeze(
			batch ? [...input] : [input as PluginTestTarget],
		) as readonly PluginTestTarget[]
		if (batch && Object.hasOwn(options ?? {}, 'initialConfig')) {
			return Promise.reject(
				new TypeError('[pluxel/test] batch start() does not accept initialConfig'),
			)
		}
		const optionsSnapshot = snapshotStartOptions(options)
		return runBuild(
			'start',
			(change) =>
				batch ? change.start(targets, optionsSnapshot) : change.start(targets[0]!, optionsSnapshot),
			(commit) => {
				assertStrict('start', commit, targets)
				const instances = targets.map((target) => readRequired(target))
				return batch ? Object.freeze(instances) : instances[0]
			},
		)
	}

	const stop = (target: PluginTestTarget): Promise<void> =>
		runBuild(
			'stop',
			(change) => change.stop(target),
			(commit) => assertStrict('stop', commit, [], [target]),
		)

	const restart = <TTarget extends PluginTestTarget>(
		target: TTarget,
	): Promise<PluginInstanceFor<TTarget>> =>
		runBuild(
			'restart',
			(change) => change.restart(target),
			(commit) => {
				assertStrict('restart', commit, [target])
				return readRequired(target)
			},
		)

	const replaceDefinition = (current: PluginConstructor, next: PluginConstructor): Promise<void> =>
		runBuild(
			'replaceDefinition',
			(change) => change.replaceDefinition(current, next),
			(commit) => {
				assertStrict('replaceDefinition', commit)
				const definition = resolvePluginTestTarget(next).address.definition
				const replacement = coordinator
					.catalogSnapshot()
					.byDefinition.get(pluginDefinitionIndexKey(definition))
				if (replacement?.candidate.implementation !== next) {
					throw new PluginLifecycleAssertionError('replaceDefinition', [current], commit.summary)
				}
			},
		)

	const commit = (build: (change: RuntimePluginTestChange) => undefined): Promise<void> =>
		runBuild('commit', build, (result) => assertStrict('commit', result))

	const commitExpectFail = (
		build: (change: RuntimePluginTestChange) => undefined,
	): Promise<LifecycleFailureCommitSummary> =>
		runBuild('commitExpectFail', build, (result) => {
			if (result.summary.lifecycleReport.issues.length === 0) {
				throw new PluginLifecycleAssertionError('commitExpectFail', result.targets, result.summary)
			}
			return result.summary as LifecycleFailureCommitSummary
		})

	const readRequired = <TTarget extends PluginTestTarget>(
		target: TTarget,
	): PluginInstanceFor<TTarget> => {
		const address = resolveCommittedTarget(target)
		const instance = pluginService.getInstance(address)
		if (!instance) throw invalidTarget('require', target, 'is not running')
		return instance as PluginInstanceFor<TTarget>
	}

	const requirePlugin = <TTarget extends PluginTestTarget>(
		target: TTarget,
	): PluginInstanceFor<TTarget> => {
		scope.assertQuery('require()')
		return readRequired(target)
	}

	const isRunning = (target: PluginTestTarget): boolean => {
		scope.assertQuery('isRunning()')
		const resolved = resolvePluginTestTarget(target)
		const entry = coordinator
			.catalogSnapshot()
			.byDefinition.get(pluginDefinitionIndexKey(resolved.address.definition))
		if (!entry) return false
		if (entry.candidate.implementation !== resolved.implementation) throw staleTarget(target)
		if (resolved.address.variant === 'fork' && !forkExists(runtimeStateStore, resolved.address)) {
			return false
		}
		return pluginService.isRunning(resolved.address)
	}

	const dispose = (): Promise<void> => {
		if (disposal) return disposal
		disposal = (async () => {
			const errors: unknown[] = []
			try {
				await scope.dispose()
			} catch (error) {
				errors.push(error)
			}
			try {
				const current = coordinator.catalogSnapshot()
				if (current.entries.length > 0) {
					const report = await coordinator.update({
						catalog: createPluginRouteCatalogSnapshot(current.revision + 1, []),
						reason: 'runtime-test-dispose',
						mode: 'live',
					})
					if (report.core.status === 'committed') {
						const summary = projectPluginTestCommitSummary(report.core.summary, pluginService)
						for (const issue of summary.lifecycleReport.issues) {
							errors.push(
								new Error(
									`[pluxel/test] ${issue.kind}/${issue.phase} during Runtime host disposal for ${issue.plugin.definition.exportName}`,
								),
							)
						}
					}
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
				throw new AggregateError(errors, '[pluxel/test] Runtime test host disposal failed')
			}
		})()
		return disposal
	}

	const host: RuntimeTestHost = Object.freeze({
		config: scope.config,
		http: scope.http,
		commands: scope.commands,
		workbench: scope.workbench,
		start,
		stop,
		restart,
		replaceDefinition,
		commit,
		commitExpectFail,
		require: requirePlugin,
		isRunning,
		dispose,
		[Symbol.asyncDispose]: dispose,
	})
	const internalHost: RuntimeInternalTestHost = Object.freeze({
		...host,
		ctx,
		root: ctx,
		pluginService,
		configService,
		coordinator,
		runtimeStateStore,
	})
	return Object.freeze({ host, internalHost })
}

function normalizeRuntimeTestConfig(
	config: RuntimeHostConfig,
	forceMemoryStores: boolean,
): RuntimeHostConfig {
	return {
		...config,
		...(Object.hasOwn(config, 'name') ? {} : { name: 'test' }),
		...(Object.hasOwn(config, 'persistence') ? {} : { persistence: { mode: 'memory' } }),
		...(forceMemoryStores
			? {
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory' },
				}
			: {
					...(Object.hasOwn(config, 'configService') ? {} : { configService: { mode: 'memory' } }),
					...(Object.hasOwn(config, 'runtimeState') ? {} : { runtimeState: { mode: 'memory' } }),
				}),
	}
}

function buildCatalog(
	plan: RuntimeDraftPlan,
	coordinator: RuntimePluginGraphCoordinator<CommitSummary>,
): Readonly<{
	entries: ReadonlyMap<string, PluginRouteCatalogEntryInput>
	snapshot?: ReturnType<typeof createPluginRouteCatalogSnapshot>
}> {
	const current = coordinator.catalogSnapshot()
	const entries = new Map<string, PluginRouteCatalogEntryInput>(
		current.entries.map((entry) => [entry.indexKey, { candidate: entry.candidate }]),
	)
	let changed = false
	for (const [key, command] of plan.catalogAdds) {
		const existing = entries.get(key)
		if (existing && existing.candidate.implementation !== command.plugin) {
			throw staleTarget(command.plugin)
		}
		if (!existing) {
			entries.set(key, Object.freeze({ candidate: command.candidate }))
			changed = true
		}
	}
	for (const [key, command] of plan.catalogRemoves) {
		const existing = entries.get(key)
		if (!existing) throw invalidTarget('catalog.remove', command.plugin, 'is not available')
		if (existing.candidate.implementation !== command.plugin) throw staleTarget(command.plugin)
		entries.delete(key)
		changed = true
	}
	for (const [key, replacement] of plan.replacements) {
		const existing = entries.get(key)
		if (!existing) throw invalidTarget('replaceDefinition', replacement.current, 'is not available')
		if (existing.candidate.implementation !== replacement.current) {
			throw staleTarget(replacement.current)
		}
		if (existing.candidate.implementation !== replacement.next) {
			entries.set(key, Object.freeze({ candidate: replacement.candidate }))
			changed = true
		}
	}
	return Object.freeze({
		entries,
		...(changed
			? { snapshot: createPluginRouteCatalogSnapshot(current.revision + 1, entries.values()) }
			: {}),
	})
}

function validatePlan(
	plan: RuntimeDraftPlan,
	entries: ReadonlyMap<string, PluginRouteCatalogEntryInput>,
	registry: PluginService,
	runtimeState: RuntimeStateStore,
): void {
	const assertAvailable = (
		operation: string,
		command: TargetCommand,
		allowPlannedFork = false,
	): void => {
		const entry = entries.get(pluginDefinitionIndexKey(command.address.definition))
		if (!entry) throw invalidTarget(operation, command.target, 'is not available')
		if (entry.candidate.implementation !== command.implementation) throw staleTarget(command.target)
		if (
			command.address.variant === 'fork' &&
			!forkExists(runtimeState, command.address) &&
			!(allowPlannedFork && plan.forkEnsures.has(pluginNodeIndexKey(command.address)))
		) {
			throw invalidTarget(operation, command.target, 'fork identity is not present')
		}
	}
	for (const command of plan.starts.values()) assertAvailable('start', command, true)
	for (const command of plan.stops.values()) assertAvailable('stop', command)
	for (const command of plan.restarts.values()) {
		assertAvailable('restart', command)
		if (!registry.isRunning(command.address)) {
			throw invalidTarget('restart', command.target, 'is not running')
		}
	}
	for (const command of plan.forkEnsures.values()) {
		assertAvailable('forks.ensure', command, true)
		const entry = entries.get(pluginDefinitionIndexKey(command.address.definition))!
		if (!entry.candidate.declaration.forkable) {
			throw invalidTarget('forks.ensure', command.target, 'Plugin definition is not forkable')
		}
	}
	for (const seed of plan.seeds.values()) {
		assertAvailable('config.seed', targetCommand(seed.target), true)
	}
	for (const command of plan.defaults.values()) {
		if (command.kind === 'set') {
			assertAvailable('dependencies.setDefault', targetCommand(command.provider))
		}
	}
	for (const command of plan.overrides.values()) {
		assertAvailable('dependencies override', targetCommand(command.consumer), true)
		if (command.kind === 'set') {
			assertAvailable('dependencies.setOverride', targetCommand(command.provider), true)
		}
	}
}

async function prepareSeeds(
	plan: RuntimeDraftPlan,
	entries: ReadonlyMap<string, PluginRouteCatalogEntryInput>,
	configService: ReturnType<typeof requireConfigService>,
	enteredLifecycle: ReadonlySet<string>,
	configuredTargets: ReadonlySet<string>,
): Promise<readonly PreparedSeed[]> {
	const prepared: PreparedSeed[] = []
	for (const [key, seed] of plan.seeds) {
		const resolved = resolvePluginTestTarget(seed.target)
		if (
			enteredLifecycle.has(key) ||
			configuredTargets.has(key) ||
			configService.getConfigRevision(resolved.address) !== 0 ||
			Object.keys(configService.getRawConfig(resolved.address)).length > 0
		) {
			throw new Error(
				'[pluxel/test] initialConfig/config.seed is only available before a Plugin node first enters lifecycle; use host.config.patch() later',
			)
		}
		const candidate = entries.get(pluginDefinitionIndexKey(resolved.address.definition))?.candidate
		const authority = candidate?.declaration.config
		if (!authority) {
			throw new Error('[pluxel/test] initialConfig/config.seed requires a Plugin config schema')
		}
		let normalized: Readonly<Record<string, unknown>> | undefined
		for (const value of seed.values) {
			const validation = await validateConfigRecord(authority.schema, value)
			if (validation.ok === false) {
				throw Object.assign(new Error('[pluxel/test] initial Plugin config validation failed'), {
					code: 'validation_failed',
					errors: validation.errors,
				})
			}
			if (normalized && !configValuesEqual(normalized, validation.output)) {
				throw conflictError('initialConfig/config.seed', seed.target, 'different normalized values')
			}
			normalized = validation.output
		}
		prepared.push(
			Object.freeze({
				key,
				address: resolved.address,
				authority,
				value: normalized!,
			}),
		)
	}
	return Object.freeze(prepared)
}

function statePatchOperations(plan: RuntimeDraftPlan): RuntimeStatePatchOperation[] {
	const operations: RuntimeStatePatchOperation[] = []
	for (const command of plan.forkEnsures.values()) {
		if (command.address.variant !== 'fork') continue
		operations.push({
			type: 'ensure-fork',
			definition: command.address.definition,
			forkId: command.address.forkId,
		})
	}
	for (const command of plan.defaults.values()) {
		operations.push({
			type: 'set-provider-default',
			token: pluginDefinitionAddressOf(command.requirement),
			provider: command.kind === 'set' ? resolvePluginTestTarget(command.provider).address : null,
		})
	}
	for (const command of plan.overrides.values()) {
		operations.push({
			type: 'set-dependency-override',
			consumer: resolvePluginTestTarget(command.consumer).address,
			requirement: pluginDefinitionAddressOf(command.requirement),
			provider: command.kind === 'set' ? resolvePluginTestTarget(command.provider).address : null,
		})
	}
	return operations
}

function assertForkRemoveExclusive(plan: RuntimeDraftPlan): void {
	if (plan.forkRemoves.size === 0) return
	const otherCount =
		plan.starts.size +
		plan.stops.size +
		plan.restarts.size +
		plan.catalogAdds.size +
		plan.catalogRemoves.size +
		plan.forkEnsures.size +
		plan.replacements.size +
		plan.seeds.size +
		plan.defaults.size +
		plan.overrides.size
	if (plan.forkRemoves.size !== 1 || otherCount !== 0) {
		throw new TypeError(
			'[pluxel/test] change.forks.remove() must be the only command in its commit callback',
		)
	}
}

async function rollbackSeeds(
	seeds: readonly PreparedSeed[],
	configService: ReturnType<typeof requireConfigService>,
	configuredTargets: Set<string>,
): Promise<void> {
	for (const seed of seeds) {
		configService.deleteConfig(seed.address)
		configuredTargets.delete(seed.key)
	}
	await configService.flush()
}

function isPreCommitRejection(error: unknown): boolean {
	return (
		error instanceof PluginGraphRejectedError ||
		error instanceof RuntimeStateMutationRejectedError ||
		error instanceof PluginStartUnavailableError ||
		error instanceof PluginRestartUnavailableError
	)
}

function forkExists(
	store: RuntimeStateStore,
	address: Extract<PluginNodeAddress, { variant: 'fork' }>,
): boolean {
	const key = pluginDefinitionIndexKey(address.definition)
	return (
		store
			.snapshot()
			.forks.find((entry) => pluginDefinitionIndexKey(entry.definition) === key)
			?.forkIds.includes(address.forkId) === true
	)
}

function targetCommand(target: PluginTestTarget): TargetCommand {
	const resolved = resolvePluginTestTarget(target)
	return Object.freeze({
		target,
		address: resolved.address,
		implementation: resolved.implementation,
	})
}

function assertNoTargetLifecycleConflict(
	plan: RuntimeDraftPlan,
	key: string,
	operation: 'start' | 'stop' | 'restart',
): void {
	for (const [name, values] of [
		['start', plan.starts],
		['stop', plan.stops],
		['restart', plan.restarts],
	] as const) {
		if (name !== operation && values.has(key)) {
			throw new Error(`[pluxel/test] Conflicting ${operation}/${name} commands for one target`)
		}
	}
}

function assertNoReplacementConflict(
	plan: RuntimeDraftPlan,
	definition: PluginDefinitionAddress,
	operation: string,
): void {
	if (plan.replacements.has(pluginDefinitionIndexKey(definition))) {
		throw new Error(`[pluxel/test] Conflicting ${operation}/replaceDefinition commands`)
	}
}

function assertDefinitionHasNoCommands(
	plan: RuntimeDraftPlan,
	definition: PluginDefinitionAddress,
	operation: string,
): void {
	const definitionKey = pluginDefinitionIndexKey(definition)
	if (plan.catalogAdds.has(definitionKey) || plan.catalogRemoves.has(definitionKey)) {
		throw new Error(`[pluxel/test] Conflicting ${operation}/catalog command`)
	}
	for (const commands of [
		plan.starts,
		plan.stops,
		plan.restarts,
		plan.forkEnsures,
		plan.forkRemoves,
		plan.seeds,
	]) {
		for (const value of commands.values()) {
			const target = value.target
			if (
				pluginDefinitionIndexKey(resolvePluginTestTarget(target).address.definition) ===
				definitionKey
			) {
				throw new Error(`[pluxel/test] Conflicting ${operation}/target command`)
			}
		}
	}
}

function assertNonEmpty<T>(values: readonly T[], operation: string): void {
	if (values.length === 0) {
		throw new TypeError(`[pluxel/test] ${operation} requires a non-empty array`)
	}
}

function assertNonEmptyUniqueTargets(
	targets: readonly PluginTestTarget[],
	operation: string,
): void {
	assertNonEmpty(targets, operation)
	const keys = new Set<string>()
	for (const target of targets) {
		const key = pluginNodeIndexKey(resolvePluginTestTarget(target).address)
		if (keys.has(key)) {
			throw new TypeError(`[pluxel/test] ${operation} contains a duplicate target`)
		}
		keys.add(key)
	}
}

function snapshotStartOptions(
	options: RuntimePluginStartOptions | undefined,
): RuntimePluginStartOptions | undefined {
	if (!options) return undefined
	return Object.freeze({
		...(options.catalog ? { catalog: Object.freeze([...options.catalog]) } : {}),
		...(options.initialConfig === undefined
			? {}
			: { initialConfig: snapshotRawConfig(options.initialConfig) }),
	})
}

function snapshotRawConfig(value: RawPluginConfig): RawPluginConfig {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('[pluxel/test] Config record must be a plain object')
	}
	return clonePortable(value, new Set(), '$') as RawPluginConfig
}

function clonePortable(value: unknown, ancestors: Set<object>, path: string): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (!value || typeof value !== 'object') {
		throw new TypeError(`[pluxel/test] Config value at ${path} is not portable data`)
	}
	if (ancestors.has(value)) {
		throw new TypeError(`[pluxel/test] Config value at ${path} has a cycle`)
	}
	ancestors.add(value)
	try {
		if (Array.isArray(value)) {
			return Object.freeze(
				value.map((item, index) => clonePortable(item, ancestors, `${path}[${index}]`)),
			)
		}
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError(`[pluxel/test] Config value at ${path} must be a plain object`)
		}
		const out: Record<string, unknown> = {}
		for (const key of Object.keys(value)) {
			out[key] = clonePortable((value as Record<string, unknown>)[key], ancestors, `${path}.${key}`)
		}
		return Object.freeze(out)
	} finally {
		ancestors.delete(value)
	}
}

function configValuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length &&
			left.every((value, index) => configValuesEqual(value, right[index]))
		)
	}
	if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
	const leftRecord = left as Record<string, unknown>
	const rightRecord = right as Record<string, unknown>
	const leftKeys = Object.keys(leftRecord).sort()
	const rightKeys = Object.keys(rightRecord).sort()
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key, index) =>
				key === rightKeys[index] && configValuesEqual(leftRecord[key], rightRecord[key]),
		)
	)
}

function sameTarget(left: PluginTestTarget, right: PluginTestTarget): boolean {
	const leftResolved = resolvePluginTestTarget(left)
	const rightResolved = resolvePluginTestTarget(right)
	return (
		leftResolved.implementation === rightResolved.implementation &&
		pluginNodeIndexKey(leftResolved.address) === pluginNodeIndexKey(rightResolved.address)
	)
}

function invalidTarget(operation: string, target: unknown, detail: string): Error {
	return new Error(`[pluxel/test] ${operation} target ${targetLabel(target)} ${detail}`)
}

function staleTarget(target: unknown): Error {
	return new Error(
		`[pluxel/test] Stale Plugin target ${targetLabel(target)}; rebuild the constructor or fork ref from the current replacement implementation`,
	)
}

function conflictError(
	operation: string,
	target: unknown,
	detail = 'contradictory commands',
): Error {
	return new Error(`[pluxel/test] Conflicting ${operation} for ${targetLabel(target)}: ${detail}`)
}

function targetLabel(target: unknown): string {
	if (typeof target === 'function') return target.name || '<anonymous>'
	if (target && typeof target === 'object' && 'plugin' in target && 'forkId' in target) {
		const value = target as { plugin: { name?: string }; forkId: string }
		return `${value.plugin.name || '<anonymous>'}#${value.forkId}`
	}
	return '<target>'
}

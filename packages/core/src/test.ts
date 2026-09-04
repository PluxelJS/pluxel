import './services/index'
import { createCoreRootContext } from './context/core-plan'
import type { CoreHostConfig } from './context/Context'
import { requireConfigService } from './internal/config-service'
import { requirePluginService } from './internal/plugin-service'
import { immutableConfigRecord } from './services/config/immutable'
import {
	consumePluginDefinitionCandidate,
	pluginDefinitionAddressOf,
} from './plugins/runtime/definition'
import {
	pluginDefinitionAddressEqual,
	pluginDefinitionIndexKey,
	isPluginNodeSlot,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from './plugins/runtime/identity'
import type { RuntimeUpdateTransaction } from './plugins/runtime/plugin-service/RuntimeUpdateTransaction'
import type { PluginService } from './plugins/runtime/PluginService'
import type { PluginConstructor, PluginToken } from './plugins/types'
import {
	assertPluginTestTargetCurrent,
	collectPluginTestDraft,
	definePluginFork,
	PluginLifecycleAssertionError,
	PluginTestOperationGate,
	projectPluginTestCommitSummary,
	resolvePluginTestTarget,
	type LifecycleFailureCommitSummary,
	type PluginForkRef,
	type PluginInstanceFor,
	type PluginInstances,
	type PluginLifecycleAssertionOperation,
	type PluginTestCommitSummary,
	type PluginTestDraftAuthority,
	type PluginTestLifecycleIssue,
	type PluginTestTarget,
	type RawPluginConfig,
} from './testing/test-primitives'

export {
	BasePlugin,
	Plugin,
	PluginPart,
	definePluginRef,
	pluginDefinitionAddressOf,
	pluginNodeAddressOf,
} from './index'
export type {
	PluginConstructor,
	PluginDefinitionAddress,
	PluginLifecycleErrorInfo,
	PluginLifecycleIssueKind,
	PluginLifecycleIssuePhase,
	PluginNodeAddress,
	PluginRef,
	PluginToken,
} from './index'
export { definePluginFork, PluginLifecycleAssertionError }
export type {
	LifecycleFailureCommitSummary,
	PluginForkRef,
	PluginInstanceFor,
	PluginInstances,
	PluginLifecycleAssertionOperation,
	PluginTestCommitSummary,
	PluginTestLifecycleIssue,
	PluginTestTarget,
	RawPluginConfig,
}

export type DependencyOverrideTarget = Readonly<{
	consumer: PluginTestTarget
	requirement: PluginToken
}>

export type DependencyOverrideInput = DependencyOverrideTarget &
	Readonly<{ provider: PluginTestTarget }>

export type ProviderDefaultInput = Readonly<{
	requirement: PluginToken
	provider: PluginConstructor
}>

export type PluginInitialConfigOptions = Readonly<{
	/** Bootstrap config, accepted only before this node first enters lifecycle. */
	initialConfig?: RawPluginConfig
}>

export type CorePluginAddOptions = PluginInitialConfigOptions

export interface CorePluginTestChange {
	add(target: PluginTestTarget, options?: CorePluginAddOptions): undefined
	add(targets: readonly PluginTestTarget[]): undefined
	remove(target: PluginTestTarget): undefined
	restart(target: PluginTestTarget): undefined
	replaceDefinition(current: PluginConstructor, next: PluginConstructor): undefined
	readonly config: {
		patch(target: PluginTestTarget, value: RawPluginConfig): undefined
	}
	readonly dependencies: {
		setDefault(input: ProviderDefaultInput): undefined
		clearDefault(requirement: PluginToken): undefined
		setOverride(input: DependencyOverrideInput): undefined
		clearOverride(input: DependencyOverrideTarget): undefined
	}
}

export interface CoreTestHost extends AsyncDisposable {
	add<TTarget extends PluginTestTarget>(
		target: TTarget,
		options?: CorePluginAddOptions,
	): Promise<PluginInstanceFor<TTarget>>
	add<const TTargets extends readonly PluginTestTarget[]>(
		targets: TTargets,
	): Promise<PluginInstances<TTargets>>
	remove(target: PluginTestTarget): Promise<void>
	restart<TTarget extends PluginTestTarget>(target: TTarget): Promise<PluginInstanceFor<TTarget>>
	replaceDefinition(current: PluginConstructor, next: PluginConstructor): Promise<void>
	commit(build: (change: CorePluginTestChange) => undefined): Promise<void>
	commitExpectFail(
		build: (change: CorePluginTestChange) => undefined,
	): Promise<LifecycleFailureCommitSummary>
	require<TTarget extends PluginTestTarget>(target: TTarget): PluginInstanceFor<TTarget>
	isRunning(target: PluginTestTarget): boolean
	dispose(): Promise<void>
}

/**
 * Core-only test host configuration. `plugins` tunes the production lifecycle executor; it is not
 * a Plugin constructor catalog. Omitted fields use the same defaults as a Core root.
 */
export type CoreTestHostConfig = Pick<CoreHostConfig, 'name' | 'logger' | 'events' | 'plugins'>

type AddCommand = Readonly<{
	target: PluginTestTarget
	address: PluginNodeAddress
	implementation: PluginConstructor
	initialConfig?: RawPluginConfig
}>

type TargetCommand = Readonly<{ target: PluginTestTarget; address: PluginNodeAddress }>

type ReplacementCommand = Readonly<{
	current: PluginConstructor
	next: PluginConstructor
	definition: PluginDefinitionAddress
}>

type DefaultCommand =
	| Readonly<{
			kind: 'set'
			requirement: PluginToken
			provider: PluginConstructor
	  }>
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

type CoreDraftPlan = {
	readonly adds: Map<string, AddCommand>
	readonly removes: Map<string, TargetCommand>
	readonly restarts: Map<string, TargetCommand>
	readonly replacements: Map<string, ReplacementCommand>
	readonly configs: Map<string, Readonly<{ target: PluginTestTarget; value: RawPluginConfig }>>
	readonly defaults: Map<string, DefaultCommand>
	readonly overrides: Map<string, OverrideCommand>
	readonly targets: Map<string, PluginTestTarget>
}

type RawCommit = Readonly<{
	summary: PluginTestCommitSummary
	targets: readonly PluginTestTarget[]
}>

/** Create an isolated Core Plugin world without starting or materializing any Plugin. */
export function createCoreTestHost(config: CoreTestHostConfig = {}): CoreTestHost {
	const root = createCoreRootContext({ ...config, name: config.name ?? 'test' })
	const registry = requirePluginService(root)
	const configService = requireConfigService(root)
	const gate = new PluginTestOperationGate()
	const enteredLifecycle = new Set<string>()
	const configuredTargets = new Set<string>()
	const explicitProviderDefaults = new Map<string, PluginDefinitionAddress>()

	const createPlan = (): CoreDraftPlan => ({
		adds: new Map(),
		removes: new Map(),
		restarts: new Map(),
		replacements: new Map(),
		configs: new Map(),
		defaults: new Map(),
		overrides: new Map(),
		targets: new Map(),
	})

	const createChange = (
		plan: CoreDraftPlan,
		authority: PluginTestDraftAuthority,
	): CorePluginTestChange => {
		const recordTarget = (target: PluginTestTarget): TargetCommand => {
			authority.assertActive('Plugin target command')
			const resolved = resolvePluginTestTarget(target)
			plan.targets.set(pluginNodeIndexKey(resolved.address), target)
			return Object.freeze({ target, address: resolved.address })
		}

		const addOne = (target: PluginTestTarget, options: CorePluginAddOptions = {}) => {
			authority.recordCommand('change.add()')
			const resolved = resolvePluginTestTarget(target)
			const key = pluginNodeIndexKey(resolved.address)
			assertNoTargetConflict(plan, key, 'add')
			assertNoReplacementConflict(plan, resolved.address.definition, 'add')
			const initialConfig =
				options.initialConfig === undefined
					? undefined
					: immutableConfigRecord(options.initialConfig)
			const previous = plan.adds.get(key)
			if (previous) {
				if (!configValuesEqual(previous.initialConfig, initialConfig)) {
					throw conflictError('add', target, 'two different initialConfig values')
				}
				return
			}
			const plannedConfig = plan.configs.get(key)
			if (
				plannedConfig &&
				initialConfig !== undefined &&
				!configValuesEqual(plannedConfig.value, initialConfig)
			) {
				throw conflictError('add/config.patch', target, 'different bootstrap config values')
			}
			plan.targets.set(key, target)
			plan.adds.set(
				key,
				Object.freeze({
					target,
					address: resolved.address,
					implementation: resolved.implementation,
					...(initialConfig === undefined ? {} : { initialConfig }),
				}),
			)
		}

		function add(target: PluginTestTarget, options?: CorePluginAddOptions): undefined
		function add(targets: readonly PluginTestTarget[]): undefined
		function add(
			input: PluginTestTarget | readonly PluginTestTarget[],
			options?: CorePluginAddOptions,
		): undefined {
			authority.assertActive('change.add()')
			if (Array.isArray(input)) {
				assertNonEmptyUniqueTargets(input, 'change.add()')
				for (const target of input) addOne(target)
			} else {
				addOne(input as PluginTestTarget, options)
			}
			return undefined
		}

		const remove = (target: PluginTestTarget): undefined => {
			authority.recordCommand('change.remove()')
			const command = recordTarget(target)
			const key = pluginNodeIndexKey(command.address)
			assertNoTargetConflict(plan, key, 'remove')
			assertNoReplacementConflict(plan, command.address.definition, 'remove')
			plan.removes.set(key, command)
			return undefined
		}

		const restart = (target: PluginTestTarget): undefined => {
			authority.recordCommand('change.restart()')
			const command = recordTarget(target)
			const key = pluginNodeIndexKey(command.address)
			assertNoTargetConflict(plan, key, 'restart')
			assertNoReplacementConflict(plan, command.address.definition, 'restart')
			plan.restarts.set(key, command)
			return undefined
		}

		const replaceDefinition = (current: PluginConstructor, next: PluginConstructor): undefined => {
			authority.recordCommand('change.replaceDefinition()')
			const currentAddress = resolvePluginTestTarget(current).address.definition
			const nextAddress = resolvePluginTestTarget(next).address.definition
			if (!pluginDefinitionAddressEqual(currentAddress, nextAddress)) {
				throw new TypeError(
					'[pluxel/test] replaceDefinition() constructors must have the same canonical definition address',
				)
			}
			const key = pluginDefinitionIndexKey(currentAddress)
			assertDefinitionHasNoTargetCommands(plan, currentAddress, 'replaceDefinition')
			const previous = plan.replacements.get(key)
			if (previous && (previous.current !== current || previous.next !== next)) {
				throw conflictError('replaceDefinition', current, 'two different replacements')
			}
			plan.replacements.set(key, Object.freeze({ current, next, definition: currentAddress }))
			plan.targets.set(pluginNodeIndexKey(resolvePluginTestTarget(current).address), current)
			return undefined
		}

		const patch = (target: PluginTestTarget, input: RawPluginConfig): undefined => {
			authority.recordCommand('change.config.patch()')
			const command = recordTarget(target)
			const key = pluginNodeIndexKey(command.address)
			assertNoReplacementConflict(plan, command.address.definition, 'config.patch')
			if (plan.removes.has(key)) throw conflictError('config.patch/remove', target)
			const value = immutableConfigRecord(input)
			const previous = plan.configs.get(key)
			if (previous && !configValuesEqual(previous.value, value)) {
				throw conflictError('config.patch', target, 'two different values')
			}
			const addCommand = plan.adds.get(key)
			if (addCommand?.initialConfig && !configValuesEqual(addCommand.initialConfig, value)) {
				throw conflictError('add/config.patch', target, 'different bootstrap config values')
			}
			plan.configs.set(key, Object.freeze({ target, value }))
			return undefined
		}

		const setDefault = (input: ProviderDefaultInput): undefined => {
			authority.recordCommand('change.dependencies.setDefault()')
			const key = pluginDefinitionIndexKey(pluginDefinitionAddressOf(input.requirement))
			const previous = plan.defaults.get(key)
			if (
				previous &&
				(previous.kind !== 'set' || !samePluginTarget(previous.provider, input.provider))
			) {
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

		const overrideKey = (input: DependencyOverrideTarget) => {
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
					!samePluginTarget(previous.consumer, input.consumer) ||
					!samePluginTarget(previous.provider, input.provider))
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
			const consumer = resolvePluginTestTarget(input.consumer)
			plan.targets.set(pluginNodeIndexKey(consumer.address), input.consumer)
			return undefined
		}

		return Object.freeze({
			add,
			remove,
			restart,
			replaceDefinition,
			config: Object.freeze({ patch }),
			dependencies: Object.freeze({
				setDefault,
				clearDefault,
				setOverride,
				clearOverride,
			}),
		})
	}

	const collect = (build: (change: CorePluginTestChange) => undefined): CoreDraftPlan =>
		collectPluginTestDraft(build, (authority) => {
			const plan = createPlan()
			return Object.freeze({ change: createChange(plan, authority), plan })
		})

	const commitPlan = async (plan: CoreDraftPlan): Promise<RawCommit> => {
		validatePlan(plan, registry, enteredLifecycle, configuredTargets)
		const update = registry.beginUpdate({ reason: 'core-test' })
		try {
			applyGraphPlan(plan, update, registry)
			const prepared = update.prepare()
			for (const [key, configPatch] of plan.configs) {
				const address = resolvePluginTestTarget(configPatch.target).address
				configService.patchConfig(address, configPatch.value)
				configuredTargets.add(key)
			}
			for (const [key, add] of plan.adds) {
				if (add.initialConfig === undefined || plan.configs.has(key)) continue
				configService.patchConfig(add.address, add.initialConfig)
				configuredTargets.add(key)
			}
			const result = await prepared.commit()
			if (result.ok === false) {
				throw result.err instanceof Error ? result.err : new Error(String(result.err))
			}
			const committed = registry.lastCommit
			if (!committed) throw new Error('[pluxel/test] Core commit completed without a summary')
			for (const key of plan.adds.keys()) enteredLifecycle.add(key)
			for (const command of plan.defaults.values()) {
				const requirement = pluginDefinitionAddressOf(command.requirement)
				const key = pluginDefinitionIndexKey(requirement)
				if (command.kind === 'set') explicitProviderDefaults.set(key, requirement)
				else explicitProviderDefaults.delete(key)
			}
			return Object.freeze({
				summary: projectPluginTestCommitSummary(committed, registry),
				targets: Object.freeze([...plan.targets.values()]),
			})
		} catch (error) {
			update.rollback()
			throw error
		}
	}

	const assertStrict = (
		operation: PluginLifecycleAssertionOperation,
		commit: RawCommit,
		requiredRunning: readonly PluginTestTarget[] = [],
	) => {
		if (
			commit.summary.lifecycleReport.issues.length > 0 ||
			requiredRunning.some((target) => !registry.isRunning(resolvePluginTestTarget(target).address))
		) {
			throw new PluginLifecycleAssertionError(operation, commit.targets, commit.summary)
		}
	}

	const runBuild = <T>(
		operation: PluginLifecycleAssertionOperation,
		build: (change: CorePluginTestChange) => undefined,
		finish: (commit: RawCommit) => T,
	): Promise<T> =>
		gate.runMutation(operation, async () => {
			const committed = await commitPlan(collect(build))
			return finish(committed)
		})

	function add<TTarget extends PluginTestTarget>(
		target: TTarget,
		options?: CorePluginAddOptions,
	): Promise<PluginInstanceFor<TTarget>>
	function add<const TTargets extends readonly PluginTestTarget[]>(
		targets: TTargets,
	): Promise<PluginInstances<TTargets>>
	function add(
		input: PluginTestTarget | readonly PluginTestTarget[],
		options?: CorePluginAddOptions,
	): Promise<unknown> {
		const batch = Array.isArray(input)
		const targets = Object.freeze(
			batch ? [...input] : [input as PluginTestTarget],
		) as readonly PluginTestTarget[]
		const optionsSnapshot =
			options?.initialConfig === undefined
				? undefined
				: Object.freeze({ initialConfig: immutableConfigRecord(options.initialConfig) })
		return runBuild(
			'add',
			(change) => (batch ? change.add(targets) : change.add(targets[0]!, optionsSnapshot)),
			(commit) => {
				assertStrict('add', commit, targets)
				const instances = targets.map((target) => readRequired(target))
				return batch ? Object.freeze(instances) : instances[0]
			},
		)
	}

	const remove = (target: PluginTestTarget): Promise<void> =>
		runBuild(
			'remove',
			(change) => change.remove(target),
			(commit) => assertStrict('remove', commit),
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
			(commit) => assertStrict('replaceDefinition', commit),
		)

	const commit = (build: (change: CorePluginTestChange) => undefined): Promise<void> =>
		runBuild('commit', build, (result) => assertStrict('commit', result))

	const commitExpectFail = (
		build: (change: CorePluginTestChange) => undefined,
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
		const address = assertPluginTestTargetCurrent(registry, target)
		const instance = registry.getInstance(address)
		if (!instance) {
			throw new Error('[pluxel/test] Required Plugin target is not running')
		}
		return instance as PluginInstanceFor<TTarget>
	}

	const requirePlugin = <TTarget extends PluginTestTarget>(
		target: TTarget,
	): PluginInstanceFor<TTarget> => {
		gate.assertReadable('require()')
		return readRequired(target)
	}

	const isRunning = (target: PluginTestTarget): boolean => {
		gate.assertReadable('isRunning()')
		const resolved = resolvePluginTestTarget(target)
		if (!registry.isMaterialized(resolved.address)) {
			const current = findDefinitionImplementation(registry, resolved.address.definition)
			if (current && current !== resolved.implementation) {
				assertPluginTestTargetCurrent(registry, target)
			}
			return false
		}
		const address = assertPluginTestTargetCurrent(registry, target)
		return registry.isRunning(address)
	}

	const dispose = (): Promise<void> =>
		gate.dispose(async () => {
			const failures: unknown[] = []
			try {
				const nodes = [...registry.graph.keys()].filter(
					(value): value is import('./index').PluginNodeSlot =>
						Boolean(value && typeof value === 'object' && 'definition' in value),
				)
				if (nodes.length > 0) {
					const update = registry.beginUpdate({ reason: 'core-test-dispose' })
					for (const requirement of explicitProviderDefaults.values()) {
						update.setProviderDefault(requirement, null)
					}
					for (const node of nodes) {
						update.dematerializeNode(registry.nodeAddressOf(node), {
							cascadeDependents: false,
						})
					}
					const result = await update.commit()
					if (result.ok === false) failures.push(result.err)
					else if (registry.lastCommit?.lifecycleReport.issues.length) {
						for (const issue of registry.lastCommit.lifecycleReport.issues) {
							failures.push(
								new Error(
									`[pluxel/test] ${issue.kind} during Core host disposal: ${issue.message}`,
									{ cause: issue.error },
								),
							)
						}
					}
				}
			} catch (error) {
				failures.push(error)
			}
			try {
				await root.effects.dispose()
			} catch (error) {
				failures.push(error)
			}
			if (failures.length > 0) {
				throw new AggregateError(failures, '[pluxel/test] Core test host disposal failed')
			}
		})

	return Object.freeze({
		add,
		remove,
		restart,
		replaceDefinition,
		commit,
		commitExpectFail,
		require: requirePlugin,
		isRunning,
		dispose,
		[Symbol.asyncDispose]: dispose,
	})
}

function validatePlan(
	plan: CoreDraftPlan,
	registry: PluginService,
	enteredLifecycle: ReadonlySet<string>,
	configuredTargets: ReadonlySet<string>,
): void {
	for (const [key, add] of plan.adds) {
		assertPluginTestTargetCurrent(registry, add.target, { allowAbsent: true })
		if (
			add.initialConfig !== undefined &&
			(enteredLifecycle.has(key) ||
				configuredTargets.has(key) ||
				registry.isMaterialized(add.address))
		) {
			throw new Error(
				'[pluxel/test] initialConfig is only available before a Plugin node first enters lifecycle; use change.config.patch() for later Core desired config',
			)
		}
	}
	for (const command of plan.removes.values()) {
		assertPluginTestTargetCurrent(registry, command.target)
		if (!registry.isMaterialized(command.address)) invalidTarget('remove', command.target)
	}
	for (const command of plan.restarts.values()) {
		assertPluginTestTargetCurrent(registry, command.target)
		if (!registry.isRunning(command.address))
			invalidTarget('restart', command.target, 'is not running')
	}
	for (const replacement of plan.replacements.values()) {
		assertPluginTestTargetCurrent(registry, replacement.current)
		if (!findDefinitionImplementation(registry, replacement.definition)) {
			invalidTarget('replaceDefinition', replacement.current, 'definition is not materialized')
		}
	}
	for (const config of plan.configs.values()) {
		const resolved = resolvePluginTestTarget(config.target)
		if (!willExist(plan, registry, resolved.address)) invalidTarget('config.patch', config.target)
		assertCurrentOrPlanned(plan, registry, config.target)
	}
	for (const command of plan.defaults.values()) {
		if (command.kind === 'clear') continue
		const provider = resolvePluginTestTarget(command.provider)
		if (!willExist(plan, registry, provider.address)) {
			invalidTarget('dependencies.setDefault', command.provider, 'provider is not materialized')
		}
		assertCurrentOrPlanned(plan, registry, command.provider)
	}
	for (const command of plan.overrides.values()) {
		const consumer = resolvePluginTestTarget(command.consumer)
		if (!willExist(plan, registry, consumer.address)) {
			invalidTarget('dependencies override', command.consumer, 'consumer is not materialized')
		}
		assertCurrentOrPlanned(plan, registry, command.consumer)
		if (command.kind === 'set') {
			const provider = resolvePluginTestTarget(command.provider)
			if (!willExist(plan, registry, provider.address)) {
				invalidTarget('dependencies.setOverride', command.provider, 'provider is not materialized')
			}
			assertCurrentOrPlanned(plan, registry, command.provider)
		}
	}
}

function applyGraphPlan(
	plan: CoreDraftPlan,
	update: RuntimeUpdateTransaction<unknown>,
	registry: PluginService,
): void {
	for (const add of plan.adds.values()) {
		if (registry.isMaterialized(add.address)) continue
		update.materializeNode(add.address, consumePluginDefinitionCandidate(add.implementation))
	}
	for (const replacement of plan.replacements.values()) {
		update.replaceDefinition(
			replacement.definition,
			consumePluginDefinitionCandidate(replacement.next),
		)
	}
	for (const command of plan.defaults.values()) {
		update.setProviderDefault(
			pluginDefinitionAddressOf(command.requirement),
			command.kind === 'set' ? resolvePluginTestTarget(command.provider).address : null,
		)
	}
	for (const command of plan.overrides.values()) {
		update.setDependencyOverride(
			resolvePluginTestTarget(command.consumer).address,
			pluginDefinitionAddressOf(command.requirement),
			command.kind === 'set' ? resolvePluginTestTarget(command.provider).address : null,
		)
	}
	for (const command of plan.restarts.values()) update.restartNode(command.address)
	for (const command of plan.removes.values()) update.dematerializeNode(command.address)
}

function assertCurrentOrPlanned(
	plan: CoreDraftPlan,
	registry: PluginService,
	target: PluginTestTarget,
): void {
	const resolved = resolvePluginTestTarget(target)
	const planned = plan.adds.get(pluginNodeIndexKey(resolved.address))
	if (planned) {
		if (planned.implementation !== resolved.implementation) {
			throw new Error('[pluxel/test] Conflicting Plugin implementations for one target')
		}
		return
	}
	assertPluginTestTargetCurrent(registry, target)
}

function willExist(
	plan: CoreDraftPlan,
	registry: PluginService,
	address: PluginNodeAddress,
): boolean {
	const key = pluginNodeIndexKey(address)
	return !plan.removes.has(key) && (plan.adds.has(key) || registry.isMaterialized(address))
}

function findDefinitionImplementation(
	registry: PluginService,
	definition: PluginDefinitionAddress,
): PluginConstructor | undefined {
	for (const key of registry.graph.keys()) {
		if (!isPluginNodeSlot(key)) continue
		const address = registry.nodeAddressOf(key)
		if (!pluginDefinitionAddressEqual(address.definition, definition)) continue
		return registry.graph.declaration(key)?.meta?.definition.implementation
	}
	return undefined
}

function assertNonEmptyUniqueTargets(targets: readonly PluginTestTarget[], action: string): void {
	if (targets.length === 0)
		throw new TypeError(`[pluxel/test] ${action} target array must not be empty`)
	const seen = new Set<string>()
	for (const target of targets) {
		const key = pluginNodeIndexKey(resolvePluginTestTarget(target).address)
		if (seen.has(key)) throw conflictError(action, target, 'duplicate target in one batch')
		seen.add(key)
	}
}

function assertNoTargetConflict(plan: CoreDraftPlan, key: string, operation: string): void {
	const conflicts = [
		plan.adds.has(key) ? 'add' : undefined,
		plan.removes.has(key) ? 'remove' : undefined,
		plan.restarts.has(key) ? 'restart' : undefined,
	].filter((value): value is string => Boolean(value && value !== operation))
	if (conflicts.length > 0) {
		throw new Error(
			`[pluxel/test] Conflicting ${conflicts[0]} and ${operation} commands for one Plugin target; use two awaited commits for observable ordering`,
		)
	}
}

function assertNoReplacementConflict(
	plan: CoreDraftPlan,
	definition: PluginDefinitionAddress,
	operation: string,
): void {
	if (!plan.replacements.has(pluginDefinitionIndexKey(definition))) return
	throw new Error(
		`[pluxel/test] Conflicting replaceDefinition and ${operation} commands for one Plugin definition`,
	)
}

function assertDefinitionHasNoTargetCommands(
	plan: CoreDraftPlan,
	definition: PluginDefinitionAddress,
	operation: string,
): void {
	for (const command of [
		...plan.adds.values(),
		...plan.removes.values(),
		...plan.restarts.values(),
	]) {
		if (pluginDefinitionAddressEqual(command.address.definition, definition)) {
			throw new Error(
				`[pluxel/test] Conflicting ${operation} and lifecycle command for one Plugin definition`,
			)
		}
	}
	for (const config of plan.configs.values()) {
		if (
			pluginDefinitionAddressEqual(
				resolvePluginTestTarget(config.target).address.definition,
				definition,
			)
		) {
			throw new Error(
				`[pluxel/test] Conflicting ${operation} and config.patch command for one Plugin definition`,
			)
		}
	}
}

function configValuesEqual(left: RawPluginConfig | undefined, right: RawPluginConfig | undefined) {
	if (left === right) return true
	if (!left || !right) return false
	return deepEqualPortable(left, right)
}

function samePluginTarget(left: PluginTestTarget, right: PluginTestTarget): boolean {
	const resolvedLeft = resolvePluginTestTarget(left)
	const resolvedRight = resolvePluginTestTarget(right)
	return (
		resolvedLeft.implementation === resolvedRight.implementation &&
		pluginNodeIndexKey(resolvedLeft.address) === pluginNodeIndexKey(resolvedRight.address)
	)
}

function deepEqualPortable(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true
	if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((item, index) => deepEqualPortable(item, right[index]))
		)
	}
	const leftKeys = Object.keys(left)
	const rightKeys = Object.keys(right)
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key) =>
				Object.hasOwn(right, key) &&
				deepEqualPortable(
					(left as Record<string, unknown>)[key],
					(right as Record<string, unknown>)[key],
				),
		)
	)
}

function conflictError(
	operation: string,
	target: PluginTestTarget | PluginToken,
	detail = '',
): Error {
	if (typeof target === 'function') {
		return new Error(
			`[pluxel/test] Conflicting ${operation} commands for ${pluginDefinitionAddressOf(target).exportName}${detail ? `: ${detail}` : ''}`,
		)
	}
	const resolved = resolvePluginTestTarget(target)
	return new Error(
		`[pluxel/test] Conflicting ${operation} commands for ${resolved.address.definition.exportName}${resolved.address.variant === 'fork' ? `#${resolved.address.forkId}` : ''}${detail ? `: ${detail}` : ''}`,
	)
}

function invalidTarget(operation: string, target: PluginTestTarget, detail = 'is absent'): never {
	const resolved = resolvePluginTestTarget(target)
	throw new Error(
		`[pluxel/test] Invalid target for ${operation}: ${resolved.address.definition.exportName}${resolved.address.variant === 'fork' ? `#${resolved.address.forkId}` : ''} ${detail}`,
	)
}

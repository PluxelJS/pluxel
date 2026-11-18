import { pluginNodeIndexKey, type Context, type PluginNodeAddress } from '@pluxel/core'
import { DEFAULT_PLUGIN_EXECUTION } from '@pluxel/core/internal'
import { SuperJSON } from 'superjson'
import { HostStateMutationRejectedError } from './mutation'
import { applyHostStatePatch, type HostStatePatch } from './state'
import {
	HostStateRevisionConflictError,
	freezeTrustedHostStateSnapshot,
	HOST_POLICY_FIELDS,
	HOST_GRAPH_POLICY_FIELDS,
	HOST_GLOBAL_POLICY_FIELDS,
	HOST_EXECUTION_POLICY_FIELDS,
	type HostStateSnapshot,
	type HostStateVersionedSnapshot,
	type HostPolicyInput,
	type HostPolicyValues,
	type HostPolicyField,
	type HostGlobalPolicyField,
	type HostNodePolicyMode,
	type HostNodePolicyTarget,
	type HostExecutionPolicy,
	type HostExecutionPolicyField,
} from './policy'
import {
	HostPolicyInputError,
	canonicalHostPolicyInput,
	indexChoices,
	nodePolicyKey,
	snapshotHostPolicy,
	sortChoices,
	type ResolvedHostPolicy,
} from './policy-input'
import {
	assertResolvedHostStoreStorage,
	type ResolvedHostStoreStorageOptions,
} from './document-storage'
import { hostInputSource, type HostInputMode, type HostInputSource } from './input-mode'
import type { HostPersistenceRetention, HostPersistenceResult } from './persistence'

export type HostStateFile = Readonly<{ version: 8 }> & HostPolicyInput
export type HostNodePolicySelection = Readonly<{
	target: HostNodePolicyTarget
	mode: HostInputMode
	source: HostInputSource
	shadowed: boolean
}>
export type HostStateConfigurationSnapshot = Readonly<{
	readonly: boolean
	managedInput: HostPolicyInput
	effective: HostPolicyValues
	mode: Readonly<Record<HostPolicyField, HostInputMode>>
	sources: Readonly<Record<HostGlobalPolicyField, HostInputSource>>
	shadowedFields: readonly HostGlobalPolicyField[]
	nodeModes: readonly HostNodePolicyMode[]
	selections: readonly HostNodePolicySelection[]
	managedRevision: string
	appliedExecution: HostExecutionPolicy
	pendingExecutionFields: readonly HostExecutionPolicyField[]
	application: 'applied' | 'requires-host-recreation'
}>

export class HostPolicyRevisionConflictError extends Error {
	readonly code = 'revision_conflict' as const
	constructor(public readonly managedRevision: string) {
		super('[host:policy] Managed input changed; refresh the policy before editing')
		this.name = 'HostPolicyRevisionConflictError'
	}
}
export class HostPolicyMutationRejectedError extends Error {
	readonly code = 'mutation_rejected' as const
	constructor() {
		super('[host:policy] Management writes are disabled by readOnly')
		this.name = 'HostPolicyMutationRejectedError'
	}
}

export class HostStateStore {
	readonly ready: Promise<void>
	readonly declaredNodes: ReadonlyMap<string, PluginNodeAddress>
	isReady = false
	private managed: HostPolicyInput = Object.freeze({})
	private revision = 0
	private readonly identity = crypto.randomUUID()
	private readonly nodeModes: ReadonlyMap<string, HostNodePolicyMode>
	private effective!: HostPolicyValues
	private configuration?: HostStateConfigurationSnapshot
	private graph!: HostStateSnapshot
	private versioned!: HostStateVersionedSnapshot
	private appliedExecution!: HostExecutionPolicy
	private disposed = false
	private closing?: Promise<void>
	private activeCommit?: Promise<HostStateVersionedSnapshot>
	readonly retention: HostPersistenceRetention

	constructor(
		readonly ctx: Context,
		private readonly options: ResolvedHostPolicy = snapshotHostPolicy(),
		private readonly documents: ResolvedHostStoreStorageOptions = {},
		declaredNodes: readonly PluginNodeAddress[] = [],
	) {
		this.nodeModes = indexChoices(options.nodeModes)
		this.declaredNodes = new Map(declaredNodes.map((node) => [pluginNodeIndexKey(node), node]))
		assertResolvedHostStoreStorage(documents)
		this.retention = documents.retention ?? (documents.storage ? 'unknown' : 'session')
		ctx.effects.defer(() => this.dispose(), { tag: 'HostStateStore' })
		const finish = () => {
			this.refresh()
			this.appliedExecution = executionValues(this.effective)
			this.isReady = true
		}
		this.ready = (documents.storage ? this.loadFromDisk() : Promise.resolve()).then(finish)
	}

	snapshot(): HostStateSnapshot {
		return this.graph
	}
	managedSnapshot(): HostPolicyInput {
		return this.managed
	}
	versionedSnapshot(): HostStateVersionedSnapshot {
		return this.versioned
	}
	managedRevision(): string {
		return `${this.identity}:policy:${this.revision}`
	}
	executionSnapshot(): HostExecutionPolicy {
		return this.appliedExecution
	}
	assertManagedRevision(expected: string | undefined): void {
		if (expected !== undefined && expected !== this.managedRevision())
			throw new HostPolicyRevisionConflictError(this.managedRevision())
	}

	private policyValues(
		saved: HostPolicyInput,
		selections?: HostNodePolicySelection[],
	): HostPolicyValues {
		const declared = this.options.declared
		const graph = freezeTrustedHostStateSnapshot({
			autoStart: this.resolveNodeChoices(
				declared.autoStart,
				saved.autoStart,
				({ node }) => ({ field: 'autoStart', node }),
				selections,
			).flatMap(({ node, autoStart }) => (autoStart ? [node] : [])),
			forks: this.resolveNodeChoices(
				declared.forks,
				saved.forks,
				({ node }) => ({ field: 'forks', node }),
				selections,
			).flatMap(({ node, deploy }) => (deploy ? [node] : [])),
			dependencyOverrides: this.resolveNodeChoices(
				declared.dependencyOverrides,
				saved.dependencyOverrides,
				({ consumerAddress, requirementAddress }) => ({
					field: 'dependencyOverrides',
					consumerAddress,
					requirementAddress,
				}),
				selections,
			).flatMap(({ consumerAddress, requirementAddress, providerAddress }) =>
				providerAddress === null ? [] : [{ consumerAddress, requirementAddress, providerAddress }],
			),
			providerDefaults: this.globalChoice(saved, 'providerDefaults'),
		})
		const execution = Object.fromEntries(
			HOST_EXECUTION_POLICY_FIELDS.map((field) => [field, this.globalChoice(saved, field)]),
		) as HostExecutionPolicy
		return Object.freeze({ ...graph, ...execution })
	}

	private resolveNodeChoices<T extends Parameters<typeof nodePolicyKey>[0]>(
		declared: readonly T[] | undefined,
		saved: readonly T[] | undefined,
		targetOf: (item: T) => HostNodePolicyTarget,
		selections: HostNodePolicySelection[] | undefined,
	): T[] {
		const declaredByKey = indexChoices(declared)
		const savedByKey = indexChoices(saved)
		const keys = new Set([...declaredByKey.keys(), ...savedByKey.keys()])
		const chosen: T[] = []
		for (const key of keys) {
			const declaredChoice = declaredByKey.get(key)
			const managedChoice = savedByKey.get(key)
			const target = targetOf((declaredChoice ?? managedChoice)!)
			const mode =
				this.nodeModes.get(
					pluginNodeIndexKey('node' in target ? target.node : target.consumerAddress),
				)?.mode ?? this.options.mode[target.field]
			const source = hostInputSource(mode, declaredChoice, managedChoice)
			const selection =
				source === 'declared' ? declaredChoice : source === 'saved' ? managedChoice : undefined
			if (selection !== undefined) chosen.push(selection)
			if (selections)
				selections.push(
					Object.freeze({
						target: Object.freeze(target),
						mode,
						source,
						shadowed: managedChoice !== undefined && source !== 'saved',
					}),
				)
		}
		return chosen
	}

	private globalChoice<K extends HostGlobalPolicyField>(
		saved: HostPolicyInput,
		field: K,
	): HostPolicyValues[K] {
		const declaredValue = this.options.declared[field]
		const savedValue = saved[field]
		const source = hostInputSource(this.options.mode[field], declaredValue, savedValue)
		return (
			source === 'declared'
				? declaredValue
				: source === 'saved'
					? savedValue
					: POLICY_DEFAULTS[field]
		) as HostPolicyValues[K]
	}

	effectiveSnapshot(input: HostPolicyInput): HostStateSnapshot {
		if (input === this.managed) return this.graph
		const graph = graphState(this.policyValues(input))
		assertPolicyGraphReferences(graph)
		return graph
	}

	configurationSnapshot(input = this.managed): HostStateConfigurationSnapshot {
		if (input === this.managed && this.configuration) return this.configuration
		const selections: HostNodePolicySelection[] = []
		const effective = this.policyValues(input, selections)
		assertPolicyGraphReferences(effective)
		const sources = Object.freeze(
			Object.fromEntries(
				HOST_GLOBAL_POLICY_FIELDS.map((field) => [
					field,
					hostInputSource(this.options.mode[field], this.options.declared[field], input[field]),
				]),
			),
		) as HostStateConfigurationSnapshot['sources']
		const pendingExecutionFields = Object.freeze(
			HOST_EXECUTION_POLICY_FIELDS.filter(
				(field) => effective[field] !== this.appliedExecution[field],
			),
		)
		const configuration: HostStateConfigurationSnapshot = Object.freeze({
			readonly: this.documents.readOnly ?? false,
			managedInput: input,
			effective,
			mode: this.options.mode,
			sources,
			shadowedFields: Object.freeze(
				HOST_GLOBAL_POLICY_FIELDS.filter(
					(field) => input[field] !== undefined && sources[field] !== 'saved',
				),
			),
			nodeModes: this.options.nodeModes,
			selections: sortChoices(
				selections,
				({ target }) => `${target.field}:${nodePolicyKey(target)}`,
			),
			managedRevision: this.managedRevision(),
			appliedExecution: this.appliedExecution,
			pendingExecutionFields,
			application: pendingExecutionFields.length > 0 ? 'requires-host-recreation' : 'applied',
		})
		if (input === this.managed) this.configuration = configuration
		return configuration
	}

	/** Apply a command to its raw choice keys and admit the intended effective graph. */
	prepareAction(patch: HostStatePatch | undefined): HostPolicyInput {
		if (!patch || patch.operations.length === 0) return this.managed
		const target = applyHostStatePatch(this.graph, patch)
		const input = applyManagedPolicyAction(
			this.managed,
			this.options.declared,
			this.graph,
			target,
			patch,
		)
		const effective = this.policyValues(input)
		const shadowed = HOST_GRAPH_POLICY_FIELDS.find(
			(field) => !equalValue(effective[field], target[field]),
		)
		if (shadowed !== undefined)
			throw new HostStateMutationRejectedError(
				Object.freeze({
					code: 'policy_shadowed',
					field: shadowed,
					message: `policy.${shadowed} is controlled by a declaration; change the declaration or its mode before this action`,
				}),
			)
		if (!hostPolicyInputEqual(input, this.managed)) this.assertMutable()
		return input
	}
	assertPatchMutable(patch: HostStatePatch | undefined): void {
		this.prepareAction(patch)
	}
	assertMutable(): void {
		if (!this.isReady) throw new Error('[HostStateStore] Policy is not ready')
		if (this.disposed) throw new Error('[HostStateStore] Policy is closed')
		if (this.documents.readOnly) throw new HostPolicyMutationRejectedError()
	}
	persistence(changed: boolean): HostPersistenceResult {
		return Object.freeze(
			changed ? { status: 'confirmed', retention: this.retention } : { status: 'unchanged' },
		)
	}
	async commitVersioned(
		expectedRevision: number,
		input: HostPolicyInput,
	): Promise<HostStateVersionedSnapshot> {
		this.assertMutable()
		if (this.activeCommit) throw new Error('[HostStateStore] Nested policy commit is not allowed')
		if (expectedRevision !== this.revision)
			throw new HostStateRevisionConflictError(expectedRevision, this.revision)
		const normalized = canonicalHostPolicyInput(input)
		this.effectiveSnapshot(normalized)
		if (hostPolicyInputEqual(this.managed, normalized)) return this.versioned
		const commit = (async () => {
			if (this.documents.storage)
				await this.documents.storage.put(
					'state.json',
					SuperJSON.stringify({ version: 8, ...normalized } satisfies HostStateFile),
				)
			this.managed = normalized
			this.revision++
			this.refresh()
			return this.versioned
		})()
		this.activeCommit = commit
		try {
			return await commit
		} finally {
			this.activeCommit = undefined
		}
	}
	dispose(): Promise<void> {
		return (this.closing ??= (async () => {
			this.disposed = true
			await this.ready.catch(() => {})
			await this.activeCommit
		})())
	}
	private refresh(): void {
		this.configuration = undefined
		this.effective = this.policyValues(this.managed)
		this.graph = graphState(this.effective)
		assertPolicyGraphReferences(this.graph)
		this.versioned = Object.freeze({ revision: this.revision, state: this.graph })
	}
	private async loadFromDisk(): Promise<void> {
		const text = await this.documents.storage!.getText('state.json')
		if (text === undefined) return
		try {
			const raw = SuperJSON.parse(text) as Record<string, unknown>
			if (!raw || typeof raw !== 'object' || Array.isArray(raw))
				throw new HostPolicyInputError('[host] persisted policy must be an object')
			if (raw.version !== 8)
				throw new HostPolicyInputError(
					`[host] unsupported persisted state version: ${String(raw.version)}`,
				)
			const { version: _, ...input } = raw
			this.managed = canonicalHostPolicyInput(input as HostPolicyInput, false)
			this.revision++
		} catch (cause) {
			throw new Error(
				'[HostStateStore] Cannot load state.json; existing document unchanged; repair it before restarting',
				{ cause },
			)
		}
	}
}

const POLICY_DEFAULTS = Object.freeze({
	providerDefaults: Object.freeze([]),
	...DEFAULT_PLUGIN_EXECUTION,
}) satisfies Pick<HostPolicyValues, HostGlobalPolicyField>

function graphState({
	autoStart,
	forks,
	providerDefaults,
	dependencyOverrides,
}: HostPolicyValues): HostStateSnapshot {
	return Object.freeze({ autoStart, forks, providerDefaults, dependencyOverrides })
}

function executionValues(values: HostPolicyValues): HostExecutionPolicy {
	return Object.freeze(
		Object.fromEntries(HOST_EXECUTION_POLICY_FIELDS.map((field) => [field, values[field]])),
	) as HostExecutionPolicy
}

export function assertPolicyGraphReferences(state: HostStateSnapshot): void {
	const forks = new Set(state.forks.map(pluginNodeIndexKey))
	const assertNode = (node: HostStateSnapshot['autoStart'][number], field: string) => {
		if (node.variant === 'fork' && !forks.has(pluginNodeIndexKey(node)))
			throw new HostPolicyInputError(
				`[host] policy.${field} references a fork absent from policy.forks`,
			)
	}
	for (const node of state.autoStart) assertNode(node, 'autoStart')
	for (const item of state.providerDefaults) assertNode(item.provider, 'providerDefaults')
	for (const item of state.dependencyOverrides) {
		assertNode(item.consumerAddress, 'dependencyOverrides')
		assertNode(item.providerAddress, 'dependencyOverrides')
	}
}

export function hostPolicyInputEqual(left: HostPolicyInput, right: HostPolicyInput): boolean {
	return equalValue(left, right)
}
export function changedPolicyFields(
	left: HostPolicyInput,
	right: HostPolicyInput,
): readonly HostPolicyField[] {
	return Object.freeze(HOST_POLICY_FIELDS.filter((field) => !equalValue(left[field], right[field])))
}
function equalValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right)
}

function applyManagedPolicyAction(
	current: HostPolicyInput,
	declared: HostPolicyInput,
	previous: HostStateSnapshot,
	target: HostStateSnapshot,
	patch: HostStatePatch,
): HostPolicyInput {
	const autoStart = indexChoices(current.autoStart)
	const forks = indexChoices(current.forks)
	const dependencyOverrides = indexChoices(current.dependencyOverrides)
	const declaredAutoStart = indexChoices(declared.autoStart)
	const declaredOverrides = indexChoices(declared.dependencyOverrides)
	const deployed = new Set(previous.forks.map(pluginNodeIndexKey))
	const started = new Set(previous.autoStart.map(pluginNodeIndexKey))
	for (const operation of patch.operations) {
		switch (operation.type) {
			case 'set-auto-start': {
				const key = pluginNodeIndexKey(operation.node)
				if (
					started.has(key) === operation.autoStart &&
					(autoStart.has(key) || declaredAutoStart.has(key))
				)
					break
				autoStart.set(key, { node: operation.node, autoStart: operation.autoStart })
				if (operation.autoStart) started.add(key)
				else started.delete(key)
				break
			}
			case 'ensure-fork': {
				const key = pluginNodeIndexKey(operation.node)
				if (!deployed.has(key)) forks.set(key, { node: operation.node, deploy: true })
				deployed.add(key)
				break
			}
			case 'remove-fork': {
				const key = pluginNodeIndexKey(operation.node)
				if (deployed.delete(key)) forks.set(key, { node: operation.node, deploy: false })
				break
			}
			case 'set-dependency-override': {
				const choice = {
					consumerAddress: operation.consumer,
					requirementAddress: operation.requirement,
					providerAddress: operation.provider,
				}
				dependencyOverrides.set(nodePolicyKey(choice), choice)
				break
			}
			case 'remove-node-policy': {
				const key = pluginNodeIndexKey(operation.node)
				if (operation.node.variant === 'fork' && !deployed.has(key)) break
				autoStart.delete(key)
				if (declaredAutoStart.get(key)?.autoStart === true)
					autoStart.set(key, { node: operation.node, autoStart: false })
				for (const [id, choice] of dependencyOverrides)
					if (pluginNodeIndexKey(choice.consumerAddress) === key) dependencyOverrides.delete(id)
				for (const [id, choice] of declaredOverrides)
					if (choice.providerAddress !== null && pluginNodeIndexKey(choice.consumerAddress) === key)
						dependencyOverrides.set(id, { ...choice, providerAddress: null })
				break
			}
		}
	}
	return canonicalHostPolicyInput({
		...current,
		autoStart: [...autoStart.values()],
		forks: [...forks.values()],
		dependencyOverrides: [...dependencyOverrides.values()],
		...(!equalValue(previous.providerDefaults, target.providerDefaults)
			? { providerDefaults: target.providerDefaults }
			: {}),
	})
}

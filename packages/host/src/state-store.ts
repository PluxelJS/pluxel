import {
	type Context as PluxelContext,
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginForkNodeAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { consumePluginDefinitionCandidate, DEFAULT_PLUGIN_EXECUTION } from '@pluxel/core/internal'
import { SuperJSON } from 'superjson'
import { HostStateMutationRejectedError } from './mutation'
import { applyHostStatePatch, type HostStatePatch } from './state'
import {
	type HostStateSnapshot,
	type HostStateVersionedSnapshot,
	HostStateRevisionConflictError,
	type HostProviderDefaultState,
	type HostDependencyOverrideState,
	freezeTrustedHostStateSnapshot,
	HOST_POLICY_FIELDS,
	HOST_GRAPH_POLICY_FIELDS,
	HOST_EXECUTION_POLICY_FIELDS,
	type HostPolicyInput,
	type HostPolicyOptions,
	type HostPolicyModes,
	type HostPolicyValues,
	type HostPolicyField,
	type HostExecutionPolicy,
	type HostExecutionPolicyField,
} from './policy'
import {
	assertResolvedHostStoreStorage,
	type ResolvedHostStoreStorageOptions,
} from './document-storage'
import { parseHostInputMode, selectHostInput, type HostInputMode } from './input-mode'
import type { HostPersistenceRetention, HostPersistenceResult } from './persistence'

export type HostStateFile = Readonly<{ version: 7 }> & HostPolicyInput
export type HostStateConfigurationSnapshot = Readonly<{
	readonly: boolean
	managedInput: HostPolicyInput
	effective: HostPolicyValues
	mode: Readonly<Record<HostPolicyField, HostInputMode>>
	sources: Readonly<Record<HostPolicyField, 'declared' | 'saved' | 'default'>>
	shadowedFields: readonly HostPolicyField[]
	managedRevision: string
	appliedExecution: HostExecutionPolicy
	pendingExecutionFields: readonly HostExecutionPolicyField[]
	application: 'applied' | 'requires-host-recreation'
}>

/** @internal Invalid author or managed policy input, distinct from arbitrary runtime failures. */
export class HostPolicyInputError extends TypeError {}

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
	isReady = false
	private managed: HostPolicyInput = Object.freeze({})
	private revision = 0
	private readonly identity = crypto.randomUUID()
	private readonly declared: HostPolicyInput
	private readonly modes: Readonly<Record<HostPolicyField, HostInputMode>>
	private effective!: HostPolicyValues
	private graph!: HostStateSnapshot
	private versioned!: HostStateVersionedSnapshot
	private appliedExecution!: HostExecutionPolicy
	private disposed = false
	private closing?: Promise<void>
	private activeCommit?: Promise<HostStateVersionedSnapshot>
	readonly retention: HostPersistenceRetention

	constructor(
		readonly ctx: PluxelContext,
		options: HostPolicyOptions = {},
		private readonly documents: ResolvedHostStoreStorageOptions = {},
	) {
		const captured = snapshotHostPolicy(options)
		const { mode, ...declared } = captured
		this.declared = canonicalHostPolicyInput(declared)
		this.modes = resolveModes(mode)
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

	policyValues(input: HostPolicyInput): HostPolicyValues {
		const values = Object.fromEntries(
			HOST_POLICY_FIELDS.map((field) => [
				field,
				selectHostInput<HostPolicyValues[HostPolicyField]>(
					this.modes[field],
					this.declared[field],
					input[field],
					POLICY_DEFAULTS[field],
				),
			]),
		) as HostPolicyValues
		assertPolicyGraphReferences(values)
		return Object.freeze(values)
	}
	effectiveSnapshot(input: HostPolicyInput): HostStateSnapshot {
		return canonicalHostStateSnapshot(this.policyValues(input))
	}
	configurationSnapshot(input = this.managed): HostStateConfigurationSnapshot {
		const effective = input === this.managed ? this.effective : this.policyValues(input)
		const sources = Object.freeze(
			Object.fromEntries(
				HOST_POLICY_FIELDS.map((field) => {
					const mode = this.modes[field]
					const source =
						mode === 'declared-only'
							? this.declared[field] === undefined
								? 'default'
								: 'declared'
							: mode === 'saved-first'
								? input[field] !== undefined
									? 'saved'
									: this.declared[field] !== undefined
										? 'declared'
										: 'default'
								: this.declared[field] !== undefined
									? 'declared'
									: input[field] !== undefined
										? 'saved'
										: 'default'
					return [field, source]
				}),
			),
		) as HostStateConfigurationSnapshot['sources']
		const pendingExecutionFields = Object.freeze(
			HOST_EXECUTION_POLICY_FIELDS.filter(
				(field) => effective[field] !== this.appliedExecution[field],
			),
		)
		return Object.freeze({
			readonly: this.documents.readOnly ?? false,
			managedInput: input,
			effective,
			mode: this.modes,
			sources,
			shadowedFields: Object.freeze(
				HOST_POLICY_FIELDS.filter(
					(field) => input[field] !== undefined && sources[field] !== 'saved',
				),
			),
			managedRevision: this.managedRevision(),
			appliedExecution: this.appliedExecution,
			pendingExecutionFields,
			application: pendingExecutionFields.length > 0 ? 'requires-host-recreation' : 'applied',
		})
	}

	/** Commands target effective columns; only actual changes materialize managed columns. */
	prepareAction(patch: HostStatePatch | undefined): HostPolicyInput {
		if (!patch || patch.operations.length === 0) return this.managed
		const target = applyHostStatePatch(this.graph, patch)
		const fields = HOST_GRAPH_POLICY_FIELDS.filter(
			(field) => !equalValue(target[field], this.graph[field]),
		)
		if (fields.length === 0) return this.managed
		this.assertMutable()
		const input = canonicalHostPolicyInput({
			...this.managed,
			...Object.fromEntries(fields.map((field) => [field, target[field]])),
		})
		const effective = this.policyValues(input)
		for (const field of fields)
			if (!equalValue(effective[field], target[field]))
				throw new HostStateMutationRejectedError(
					Object.freeze({
						code: 'policy_shadowed',
						field,
						message: `policy.${field} is controlled by its ${this.modes[field]} declaration; change the declaration or mode before this action`,
					}),
				)
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
		this.policyValues(normalized)
		if (hostPolicyInputEqual(this.managed, normalized)) return this.versioned
		const commit = (async () => {
			if (this.documents.storage)
				await this.documents.storage.put(
					'state.json',
					SuperJSON.stringify({ version: 7, ...normalized } satisfies HostStateFile),
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
		this.effective = this.policyValues(this.managed)
		this.graph = canonicalHostStateSnapshot(this.effective)
		this.versioned = Object.freeze({ revision: this.revision, state: this.graph })
	}
	private async loadFromDisk(): Promise<void> {
		const text = await this.documents.storage!.getText('state.json')
		if (text === undefined) return
		try {
			const raw = SuperJSON.parse(text) as Record<string, unknown>
			assertPolicyRecord(raw, ['version', ...HOST_POLICY_FIELDS], 'persisted policy')
			if (raw.version !== 7)
				throw invalidState(`unsupported persisted state version: ${String(raw.version)}`)
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

const EMPTY_GRAPH = Object.freeze({
	autoStart: [],
	forks: [],
	providerDefaults: [],
	dependencyOverrides: [],
})
const POLICY_DEFAULTS: HostPolicyValues = Object.freeze({
	...EMPTY_GRAPH,
	...DEFAULT_PLUGIN_EXECUTION,
})

export function snapshotHostPolicy(
	input: HostPolicyOptions = {},
): HostPolicyInput & Readonly<{ mode?: HostPolicyModes }> {
	assertPolicyRecord(input, [...HOST_POLICY_FIELDS, 'mode'], 'policy')
	const { mode, autoStart, ...rest } = input
	if (autoStart !== undefined && !Array.isArray(autoStart))
		throw new HostPolicyInputError('[host] policy.autoStart must be an array')
	const declared = canonicalHostPolicyInput({
		...rest,
		...(autoStart === undefined
			? {}
			: {
					autoStart: snapshotPolicyArray(autoStart, 'policy.autoStart').map((value) =>
						typeof value === 'function'
							? {
									definition: consumePluginDefinitionCandidate(value).declaration.address,
									variant: 'default' as const,
								}
							: value,
					),
				}),
	})
	return Object.freeze({ ...declared, ...(mode === undefined ? {} : { mode: resolveModes(mode) }) })
}
/** @internal Capture portable sequence structure before reading any element. */
export function snapshotPolicyArray<T>(input: readonly T[], label: string): readonly T[] {
	if (!Array.isArray(input)) throw new HostPolicyInputError(`[host] ${label} must be an array`)
	const descriptors = Object.getOwnPropertyDescriptors(input)
	for (const key of Reflect.ownKeys(descriptors)) {
		if (key === 'length') continue
		if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length)
			throw new HostPolicyInputError(`[host] ${label} cannot contain additional properties`)
		const descriptor = descriptors[key]!
		if (!descriptor.enumerable || !('value' in descriptor))
			throw new HostPolicyInputError(`[host] ${label} requires enumerable data properties`)
	}
	const output: T[] = []
	for (let index = 0; index < input.length; index++) {
		const descriptor = descriptors[String(index)]
		if (!descriptor) throw new HostPolicyInputError(`[host] ${label} must be a dense array`)
		output.push(descriptor.value as T)
	}
	return Object.freeze(output)
}
function resolveModes(
	input: HostPolicyModes = {},
): Readonly<Record<HostPolicyField, HostInputMode>> {
	assertPolicyRecord(input, HOST_POLICY_FIELDS, 'policy.mode')
	return Object.freeze(
		Object.fromEntries(
			HOST_POLICY_FIELDS.map((field) => [
				field,
				parseHostInputMode(input[field], `policy.mode.${field}`),
			]),
		),
	) as Readonly<Record<HostPolicyField, HostInputMode>>
}
export function canonicalHostPolicyInput(
	input: HostPolicyInput,
	optionalUndefined = true,
): HostPolicyInput {
	assertPolicyRecord(input, HOST_POLICY_FIELDS, 'policy input')
	const entries = Object.entries(input).filter(
		([, value]) => !(optionalUndefined && value === undefined),
	)
	const supplied = Object.fromEntries(entries)
	assertPortablePolicy(supplied)
	const graph = canonicalHostStateSnapshot({ ...EMPTY_GRAPH, ...supplied } as HostStateSnapshot)
	const output: Record<string, unknown> = {}
	for (const field of HOST_POLICY_FIELDS) {
		if (!Object.hasOwn(supplied, field)) continue
		const value = supplied[field]
		if ((HOST_GRAPH_POLICY_FIELDS as readonly string[]).includes(field))
			output[field] = graph[field as keyof HostStateSnapshot]
		else {
			const max = field.endsWith('TimeoutMs') ? 2_147_483_647 : Number.MAX_SAFE_INTEGER
			if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max)
				throw new HostPolicyInputError(
					`[host] policy.${field} must be an integer between 1 and ${max}`,
				)
			output[field] = value
		}
	}
	return Object.freeze(output)
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
function executionValues(values: HostPolicyValues): HostExecutionPolicy {
	return Object.freeze(
		Object.fromEntries(HOST_EXECUTION_POLICY_FIELDS.map((field) => [field, values[field]])),
	) as HostExecutionPolicy
}

export function assertPolicyGraphReferences(state: HostStateSnapshot): void {
	const forks = new Set(state.forks.map(pluginNodeIndexKey))
	const assertNode = (node: PluginNodeAddress, field: string) => {
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
export function canonicalHostStateSnapshot(state: HostStateSnapshot): HostStateSnapshot {
	for (const field of HOST_GRAPH_POLICY_FIELDS)
		if (!Array.isArray(state[field])) throw invalidState(`${field} must be an array`)
	return freezeTrustedHostStateSnapshot({
		autoStart: parseUniqueNodes(state.autoStart, 'autoStart'),
		forks: parseForks(state.forks, 'forks'),
		providerDefaults: parseProviderDefaults(state.providerDefaults, 'providerDefaults'),
		dependencyOverrides: parseDependencyOverrides(state.dependencyOverrides, 'dependencyOverrides'),
	})
}
function assertPolicyRecord(
	value: unknown,
	keys: readonly string[],
	label: string,
): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		throw new HostPolicyInputError(`[host] ${label} must be a plain object`)
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string' || !keys.includes(key))
			throw new HostPolicyInputError(`[host] ${label} includes unsupported ${String(key)}`)
		if (!Object.getOwnPropertyDescriptor(value, key)!.enumerable)
			throw new HostPolicyInputError(`[host] ${label} cannot contain hidden fields`)
		if (!('value' in Object.getOwnPropertyDescriptor(value, key)!))
			throw new HostPolicyInputError(`[host] ${label} cannot contain accessors`)
	}
}
function assertPortablePolicy(value: unknown, seen = new Set<object>()): void {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isFinite(value))
	)
		return
	if (
		!value ||
		typeof value !== 'object' ||
		seen.has(value) ||
		(!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
	)
		throw new HostPolicyInputError('[host] policy input must be a portable data tree')
	seen.add(value)
	for (const key of Reflect.ownKeys(value)) {
		if (Array.isArray(value) && key === 'length') continue
		if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key))
			throw new HostPolicyInputError('[host] unsafe policy input key')
		if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
			throw new HostPolicyInputError('[host] policy arrays cannot contain additional properties')
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!
		if (!descriptor.enumerable)
			throw new HostPolicyInputError('[host] policy input cannot contain hidden fields')
		if (!('value' in descriptor))
			throw new HostPolicyInputError('[host] policy input cannot contain accessors')
		assertPortablePolicy(descriptor.value, seen)
	}
	if (Array.isArray(value) && Object.keys(value).length !== value.length)
		throw new HostPolicyInputError('[host] policy arrays must be dense')
	seen.delete(value)
}
function parseUniqueNodes(input: readonly unknown[], at: string): PluginNodeAddress[] {
	const out: PluginNodeAddress[] = []
	const seen = new Set<string>()
	for (let i = 0; i < input.length; i++) {
		const node = parseNode(input[i], `${at}[${i}]`)
		const key = pluginNodeIndexKey(node)
		if (seen.has(key)) {
			throw invalidState(`${at}[${i}] duplicates an earlier node`)
		}
		seen.add(key)
		out.push(node)
	}
	return out.sort((left, right) =>
		pluginNodeIndexKey(left).localeCompare(pluginNodeIndexKey(right)),
	)
}

function parseForks(input: readonly unknown[], at: string): PluginForkNodeAddress[] {
	return parseUniqueNodes(input, at).map((node) => {
		if (node.variant !== 'fork') throw invalidState(`${at} must contain only fork node addresses`)
		return node
	})
}

function parseProviderDefaults(input: readonly unknown[], at: string): HostProviderDefaultState[] {
	const out: HostProviderDefaultState[] = []
	const seen = new Set<string>()
	for (let i = 0; i < input.length; i++) {
		const raw = closedRecord(input[i], `${at}[${i}]`, ['token', 'provider'])
		const token = parseDefinition(raw.token, `${at}[${i}].token`)
		const provider = parseNode(raw.provider, `${at}[${i}].provider`)
		const key = pluginDefinitionIndexKey(token)
		if (seen.has(key)) {
			throw invalidState(`${at}[${i}] duplicates a provider token`)
		}
		seen.add(key)
		out.push({ token, provider })
	}
	return out.sort((left, right) =>
		pluginDefinitionIndexKey(left.token).localeCompare(pluginDefinitionIndexKey(right.token)),
	)
}

function parseDependencyOverrides(
	input: readonly unknown[],
	at: string,
): HostDependencyOverrideState[] {
	const out: HostDependencyOverrideState[] = []
	const seen = new Set<string>()
	for (let i = 0; i < input.length; i++) {
		const raw = closedRecord(input[i], `${at}[${i}]`, [
			'consumerAddress',
			'requirementAddress',
			'providerAddress',
		])
		const consumerAddress = parseNode(raw.consumerAddress, `${at}[${i}].consumerAddress`)
		const requirementAddress = parseDefinition(
			raw.requirementAddress,
			`${at}[${i}].requirementAddress`,
		)
		const providerAddress = parseNode(raw.providerAddress, `${at}[${i}].providerAddress`)
		const key = `${pluginNodeIndexKey(consumerAddress)}:${pluginDefinitionIndexKey(requirementAddress)}`
		if (seen.has(key)) {
			throw invalidState(`${at}[${i}] duplicates a consumer requirement`)
		}
		seen.add(key)
		out.push({ consumerAddress, requirementAddress, providerAddress })
	}
	return out.sort((left, right) => {
		const leftKey = `${pluginNodeIndexKey(left.consumerAddress)}:${pluginDefinitionIndexKey(left.requirementAddress)}`
		const rightKey = `${pluginNodeIndexKey(right.consumerAddress)}:${pluginDefinitionIndexKey(right.requirementAddress)}`
		return leftKey.localeCompare(rightKey)
	})
}

function parseDefinition(value: unknown, at: string): PluginDefinitionAddress {
	try {
		return parsePluginDefinitionAddress(value)
	} catch (error) {
		throw invalidState(`${at}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function parseNode(value: unknown, at: string): PluginNodeAddress {
	try {
		return parsePluginNodeAddress(value)
	} catch (error) {
		throw invalidState(`${at}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function closedRecord(
	value: unknown,
	at: string,
	keys: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw invalidState(`${at} must be an object`)
	}
	const record = value as Record<string, unknown>
	assertClosedRecord(record, keys, at)
	return record
}

function assertClosedRecord(
	record: object,
	keys: readonly string[],
	at: string,
	requireAll = true,
): void {
	const expected = new Set(keys)
	for (const key of Object.keys(record)) {
		if (!expected.has(key)) throw invalidState(`${at} has unknown field ${key}`)
	}
	if (!requireAll) return
	for (const key of keys) {
		if (!Object.hasOwn(record, key)) throw invalidState(`${at} is missing field ${key}`)
	}
}

function invalidState(message: string): Error {
	return new HostPolicyInputError(`[HostStateStore] ${message}`)
}

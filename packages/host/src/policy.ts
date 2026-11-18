import type { HostInputMode } from './input-mode'
import type { HostDocumentOptions } from './document-storage'
import {
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginForkNodeAddress,
	type PluginNodeAddress,
	type CoreExecutionConfig,
} from '@pluxel/core'

export type HostStateSnapshot = Readonly<{
	/** Complete node identities from source classes, generated providers or discovery. Does not load implementations. */
	autoStart: readonly PluginNodeAddress[]
	forks: readonly PluginForkNodeAddress[]
	providerDefaults: readonly HostProviderDefaultState[]
	dependencyOverrides: readonly HostDependencyOverrideState[]
}>

export type HostExecutionPolicy = Required<CoreExecutionConfig>
export type HostPolicyValues = HostStateSnapshot & HostExecutionPolicy
export type HostPolicyField = keyof HostPolicyValues
export type HostExecutionPolicyField = keyof HostExecutionPolicy
export type HostNodePolicyField = 'autoStart' | 'forks' | 'dependencyOverrides'
export type HostGlobalPolicyField = Exclude<HostPolicyField, HostNodePolicyField>
export type HostAutoStartChoice = Readonly<{ node: PluginNodeAddress; autoStart: boolean }>
export type HostForkChoice = Readonly<{ node: PluginForkNodeAddress; deploy: boolean }>
export type HostDependencyOverrideChoice = Readonly<
	Omit<HostDependencyOverrideState, 'providerAddress'> & {
		providerAddress: PluginNodeAddress | null
	}
>
export type HostNodePolicyTarget =
	| Readonly<{ field: 'autoStart'; node: PluginNodeAddress }>
	| Readonly<{ field: 'forks'; node: PluginForkNodeAddress }>
	| Readonly<{
			field: 'dependencyOverrides'
			consumerAddress: PluginNodeAddress
			requirementAddress: PluginDefinitionAddress
	  }>
export type HostPolicyResetTarget = HostGlobalPolicyField | HostNodePolicyTarget
/** Explicit, sparse saved choices. Empty node arrays provide no keys. */
export type HostPolicyInput = Readonly<
	Partial<Pick<HostPolicyValues, HostGlobalPolicyField>> & {
		autoStart?: readonly HostAutoStartChoice[]
		forks?: readonly HostForkChoice[]
		dependencyOverrides?: readonly HostDependencyOverrideChoice[]
	}
>
export type HostPolicyPatch = HostPolicyInput &
	Readonly<{ reset?: readonly HostPolicyResetTarget[] }>
export type HostPolicyModes = Readonly<Partial<Record<HostPolicyField, HostInputMode>>>
export type HostPolicyOptions = Readonly<{
	mode?: HostInputMode
	modes?: HostPolicyModes
	document?: false | HostDocumentOptions
	providerDefaults?: readonly HostProviderDefaultState[]
	execution?: CoreExecutionConfig
}>
export type HostNodePolicyMode = Readonly<{ node: PluginNodeAddress; mode: HostInputMode }>
export const HOST_GRAPH_POLICY_FIELDS = [
	'autoStart',
	'forks',
	'providerDefaults',
	'dependencyOverrides',
] as const
export const HOST_EXECUTION_POLICY_FIELDS = [
	'startTimeoutMs',
	'drainTimeoutMs',
	'startConcurrency',
	'stopConcurrency',
] as const
export const HOST_POLICY_FIELDS = [
	...HOST_GRAPH_POLICY_FIELDS,
	...HOST_EXECUTION_POLICY_FIELDS,
] as const
export const HOST_GLOBAL_POLICY_FIELDS = [
	'providerDefaults',
	...HOST_EXECUTION_POLICY_FIELDS,
] as const
export const HOST_NODE_POLICY_FIELDS = ['autoStart', 'forks', 'dependencyOverrides'] as const

export type HostStateVersionedSnapshot = Readonly<{
	revision: number
	state: HostStateSnapshot
}>

export class HostStateRevisionConflictError extends Error {
	public readonly code = 'runtime_state_revision_conflict' as const

	constructor(
		public readonly expectedRevision: number,
		public readonly actualRevision: number,
	) {
		super(`[HostStateStore] revision changed from ${expectedRevision} to ${actualRevision}`)
		this.name = 'HostStateRevisionConflictError'
	}
}

export type HostStateDraft = {
	autoStart: PluginNodeAddress[]
	forks: PluginForkNodeAddress[]
	providerDefaults: HostProviderDefaultState[]
	dependencyOverrides: HostDependencyOverrideState[]
}

export type HostForkState = PluginForkNodeAddress

export type HostProviderDefaultState = {
	token: PluginDefinitionAddress
	provider: PluginNodeAddress
}

export type HostDependencyOverrideState = {
	consumerAddress: PluginNodeAddress
	requirementAddress: PluginDefinitionAddress
	providerAddress: PluginNodeAddress
}

/** @internal Deep-freezes already-admitted state and imposes canonical serialization order. */
export function freezeTrustedHostStateSnapshot(
	draft: HostStateDraft | HostStateSnapshot,
): HostStateSnapshot {
	const snapshot: HostStateSnapshot = Object.freeze({
		autoStart: Object.freeze(sortByKey(draft.autoStart.map(freezeNodeAddress), pluginNodeIndexKey)),
		forks: Object.freeze(
			sortByKey(
				draft.forks.map((node) => freezeNodeAddress(node)),
				pluginNodeIndexKey,
			),
		),
		providerDefaults: Object.freeze(
			sortByKey(
				draft.providerDefaults.map((entry) =>
					Object.freeze({
						token: freezeDefinitionAddress(entry.token),
						provider: freezeNodeAddress(entry.provider),
					}),
				),
				(entry) => pluginDefinitionIndexKey(entry.token),
			),
		),
		dependencyOverrides: Object.freeze(
			sortByKey(
				draft.dependencyOverrides.map((entry) =>
					Object.freeze({
						consumerAddress: freezeNodeAddress(entry.consumerAddress),
						requirementAddress: freezeDefinitionAddress(entry.requirementAddress),
						providerAddress: freezeNodeAddress(entry.providerAddress),
					}),
				),
				(entry) => overrideIndexKey(entry.consumerAddress, entry.requirementAddress),
			),
		),
	})

	return snapshot
}

function overrideIndexKey(
	consumer: PluginNodeAddress,
	requirement: PluginDefinitionAddress,
): string {
	return `${pluginNodeIndexKey(consumer)}:${pluginDefinitionIndexKey(requirement)}`
}

function sortByKey<T>(values: T[], keyOf: (value: T) => string): T[] {
	return values
		.map((value, order) => ({ value, key: keyOf(value), order }))
		.sort((left, right) => left.key.localeCompare(right.key) || left.order - right.order)
		.map(({ value }) => value)
}

function freezeDefinitionAddress(definition: PluginDefinitionAddress): PluginDefinitionAddress {
	const entry = Object.freeze({ ...definition.entry })
	return Object.freeze({
		entry,
		exportName: definition.exportName,
	}) as PluginDefinitionAddress
}

function freezeNodeAddress(node: PluginForkNodeAddress): PluginForkNodeAddress
function freezeNodeAddress(node: PluginNodeAddress): PluginNodeAddress
function freezeNodeAddress(node: PluginNodeAddress): PluginNodeAddress {
	return Object.freeze(
		node.variant === 'default'
			? { definition: freezeDefinitionAddress(node.definition), variant: 'default' as const }
			: {
					definition: freezeDefinitionAddress(node.definition),
					variant: 'fork' as const,
					forkId: node.forkId,
				},
	)
}

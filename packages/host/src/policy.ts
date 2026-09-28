import {
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'

export type HostStateSnapshot = Readonly<{
	autoStart: readonly PluginNodeAddress[]
	forks: readonly HostForkState[]
	providerDefaults: readonly HostProviderDefaultState[]
	dependencyOverrides: readonly HostDependencyOverrideState[]
}>

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
	forks: HostForkState[]
	providerDefaults: HostProviderDefaultState[]
	dependencyOverrides: HostDependencyOverrideState[]
}

export type HostForkState = {
	definition: PluginDefinitionAddress
	forkIds: readonly string[]
}

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
				draft.forks.map((entry) =>
					Object.freeze({
						definition: freezeDefinitionAddress(entry.definition),
						forkIds: Object.freeze([...entry.forkIds].sort()),
					}),
				),
				(entry) => pluginDefinitionIndexKey(entry.definition),
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

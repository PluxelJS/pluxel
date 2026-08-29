import {
	pluginDefinitionAddressEqual,
	pluginDefinitionIndexKey,
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	freezeTrustedRuntimeStateSnapshot,
	type RuntimeDependencyOverrideState,
	type RuntimeProviderDefaultState,
	type RuntimeStateSnapshot,
} from '../../services/RuntimeStateStore'
import {
	pluginCatalogEntry,
	type PluginRouteCatalogEntry,
	type PluginRouteCatalogSnapshot,
} from './catalog'
import type { RuntimeStatePatch, RuntimeStatePatchOperation } from './state'

export type RuntimeStateMutationRejection =
	| Readonly<{
			code: 'definition_unavailable'
			definition: PluginDefinitionAddress
			message: string
	  }>
	| Readonly<{
			code: 'not_forkable'
			node: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			code: 'node_unavailable' | 'consumer_unavailable' | 'provider_unavailable'
			node: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			code: 'fork_referenced'
			node: PluginNodeAddress
			references: readonly Readonly<{
				consumer: PluginNodeAddress
				requirement: PluginDefinitionAddress
			}>[]
			message: string
	  }>
	| Readonly<{
			code: 'fork_default_forbidden'
			provider: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			code: 'requirement_not_found'
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
			message: string
	  }>
	| Readonly<{
			code: 'provider_incompatible' | 'provider_default_requires_abstract'
			provider: PluginNodeAddress
			requirement: PluginDefinitionAddress
			message: string
	  }>

export class RuntimeStateMutationRejectedError extends Error {
	public readonly code: RuntimeStateMutationRejection['code']

	constructor(public readonly issue: RuntimeStateMutationRejection) {
		super(`[runtime:state] ${issue.message}`)
		this.name = 'RuntimeStateMutationRejectedError'
		this.code = issue.code
	}
}

/**
 * Admits new durable graph intent against one coordinator-pinned catalog/state pair.
 *
 * Exact existing intent is allowed to survive later catalog unavailability. A mutation that
 * creates or changes intent must be structurally valid at its serialization point. Operations
 * are checked in patch order so callers can compose prerequisite and cleanup operations safely.
 */
export function validateRuntimeStateMutation(
	catalog: PluginRouteCatalogSnapshot,
	pinnedState: RuntimeStateSnapshot,
	patch: RuntimeStatePatch | undefined,
): void {
	if (!patch || patch.operations.length === 0) return
	admitRuntimeStateMutation(catalog, pinnedState, patch)
}

/** Admits and applies one patch while reusing the same pinned-state indexes. */
export function applyRuntimeStateMutation(
	catalog: PluginRouteCatalogSnapshot,
	pinnedState: RuntimeStateSnapshot,
	patch: RuntimeStatePatch | undefined,
): RuntimeStateSnapshot {
	if (!patch || patch.operations.length === 0) return pinnedState
	return snapshotAdmissionState(admitRuntimeStateMutation(catalog, pinnedState, patch))
}

function admitRuntimeStateMutation(
	catalog: PluginRouteCatalogSnapshot,
	pinnedState: RuntimeStateSnapshot,
	patch: RuntimeStatePatch,
): AdmissionState {
	const state = createAdmissionState(pinnedState)
	for (const operation of patch.operations) validateOperation(catalog, state, operation)
	return state
}

type AdmissionState = {
	autoStart: Map<string, PluginNodeAddress>
	forks: Map<string, { definition: PluginDefinitionAddress; forkIds: Set<string> }>
	providerDefaults: Map<string, RuntimeProviderDefaultState>
	dependencyOverrides: Map<string, RuntimeDependencyOverrideState>
	overridesByProvider: Map<string, Set<string>>
	overridesByConsumer: Map<string, Set<string>>
}

function createAdmissionState(snapshot: RuntimeStateSnapshot): AdmissionState {
	const state: AdmissionState = {
		autoStart: new Map(snapshot.autoStart.map((node) => [pluginNodeIndexKey(node), node])),
		forks: new Map(
			snapshot.forks.map((entry) => [
				pluginDefinitionIndexKey(entry.definition),
				{ definition: entry.definition, forkIds: new Set(entry.forkIds) },
			]),
		),
		providerDefaults: new Map(
			snapshot.providerDefaults.map((entry) => [pluginDefinitionIndexKey(entry.token), entry]),
		),
		dependencyOverrides: new Map(),
		overridesByProvider: new Map(),
		overridesByConsumer: new Map(),
	}
	for (const override of snapshot.dependencyOverrides) setOverride(state, override)
	return state
}

function snapshotAdmissionState(state: AdmissionState): RuntimeStateSnapshot {
	return freezeTrustedRuntimeStateSnapshot({
		autoStart: [...state.autoStart.values()],
		forks: [...state.forks.values()].map((entry) => ({
			definition: entry.definition,
			forkIds: [...entry.forkIds],
		})),
		providerDefaults: [...state.providerDefaults.values()],
		dependencyOverrides: [...state.dependencyOverrides.values()],
	})
}

function validateOperation(
	catalog: PluginRouteCatalogSnapshot,
	state: AdmissionState,
	operation: RuntimeStatePatchOperation,
): void {
	switch (operation.type) {
		case 'set-auto-start': {
			const key = pluginNodeIndexKey(operation.node)
			if (!operation.autoStart) {
				state.autoStart.delete(key)
				return
			}
			if (state.autoStart.has(key)) return
			// A durable fork remains valid desired intent while its catalog route is temporarily absent.
			if (operation.node.variant === 'fork' && isDurableFork(state, operation.node)) {
				state.autoStart.set(key, operation.node)
				return
			}
			requireAvailableNode(catalog, state, operation.node, 'node_unavailable')
			state.autoStart.set(key, operation.node)
			return
		}
		case 'ensure-fork': {
			const node: PluginNodeAddress = {
				definition: operation.definition,
				variant: 'fork',
				forkId: operation.forkId,
			}
			if (isDurableFork(state, node)) return
			const entry = pluginCatalogEntry(catalog, operation.definition)
			if (!entry) {
				reject({
					code: 'definition_unavailable',
					definition: operation.definition,
					message: 'Plugin definition is unavailable in the route catalog',
				})
			}
			if (!entry.candidate.declaration.forkable) {
				reject({
					code: 'not_forkable',
					node,
					message: 'Plugin definition does not allow fork nodes',
				})
			}
			const key = pluginDefinitionIndexKey(operation.definition)
			const family = state.forks.get(key) ?? {
				definition: operation.definition,
				forkIds: new Set<string>(),
			}
			family.forkIds.add(operation.forkId)
			state.forks.set(key, family)
			return
		}
		case 'remove-fork': {
			const node: PluginNodeAddress = {
				definition: operation.definition,
				variant: 'fork',
				forkId: operation.forkId,
			}
			if (!isDurableFork(state, node)) return
			const references = [...(state.overridesByProvider.get(pluginNodeIndexKey(node)) ?? [])]
				.map((key) => state.dependencyOverrides.get(key))
				.filter((entry): entry is RuntimeDependencyOverrideState => !!entry)
				.map((entry) =>
					Object.freeze({
						consumer: entry.consumerAddress,
						requirement: entry.requirementAddress,
					}),
				)
			if (references.length > 0) {
				reject({
					code: 'fork_referenced',
					node,
					references: Object.freeze(references),
					message: 'Fork is referenced by dependency overrides',
				})
			}
			const familyKey = pluginDefinitionIndexKey(operation.definition)
			const family = state.forks.get(familyKey)!
			family.forkIds.delete(operation.forkId)
			if (family.forkIds.size === 0) state.forks.delete(familyKey)
			return
		}
		case 'set-provider-default': {
			const key = pluginDefinitionIndexKey(operation.token)
			if (!operation.provider) {
				state.providerDefaults.delete(key)
				return
			}
			const existing = state.providerDefaults.get(key)?.provider
			if (existing && pluginNodeAddressEqual(existing, operation.provider)) return
			if (operation.provider.variant === 'fork') {
				reject({
					code: 'fork_default_forbidden',
					provider: operation.provider,
					message: 'A fork cannot be selected as a global provider default',
				})
			}
			const entry = requireAvailableNode(catalog, state, operation.provider, 'provider_unavailable')
			if (!providerCompatible(entry, operation.token)) {
				reject({
					code: 'provider_incompatible',
					provider: operation.provider,
					requirement: operation.token,
					message: 'Provider does not implement the requested requirement',
				})
			}
			if (
				!entry.candidate.declaration.provides ||
				!pluginDefinitionAddressEqual(entry.candidate.declaration.provides, operation.token)
			) {
				reject({
					code: 'provider_default_requires_abstract',
					provider: operation.provider,
					requirement: operation.token,
					message: 'Global provider default must publish the requested abstract token',
				})
			}
			state.providerDefaults.set(key, {
				token: operation.token,
				provider: operation.provider,
			})
			return
		}
		case 'set-dependency-override': {
			const key = overrideKey(operation.consumer, operation.requirement)
			const consumer = requireAvailableNode(
				catalog,
				state,
				operation.consumer,
				'consumer_unavailable',
			)
			if (
				!consumer.candidate.declaration.requires.some((requirement) =>
					pluginDefinitionAddressEqual(requirement, operation.requirement),
				)
			) {
				reject({
					code: 'requirement_not_found',
					consumer: operation.consumer,
					requirement: operation.requirement,
					message: 'Dependency requirement does not exist on the consumer',
				})
			}
			if (!operation.provider) {
				removeOverride(state, key)
				return
			}
			const existing = state.dependencyOverrides.get(key)?.providerAddress
			if (existing && pluginNodeAddressEqual(existing, operation.provider)) return
			const provider = requireAvailableNode(
				catalog,
				state,
				operation.provider,
				'provider_unavailable',
			)
			if (!providerCompatible(provider, operation.requirement)) {
				reject({
					code: 'provider_incompatible',
					provider: operation.provider,
					requirement: operation.requirement,
					message: 'Provider does not implement the requested requirement',
				})
			}
			setOverride(state, {
				consumerAddress: operation.consumer,
				requirementAddress: operation.requirement,
				providerAddress: operation.provider,
			})
			return
		}
		case 'remove-node-policy': {
			state.autoStart.delete(pluginNodeIndexKey(operation.node))
			for (const key of state.overridesByConsumer.get(pluginNodeIndexKey(operation.node)) ?? []) {
				removeOverride(state, key)
			}
			return
		}
	}
}

function requireAvailableNode(
	catalog: PluginRouteCatalogSnapshot,
	state: AdmissionState,
	node: PluginNodeAddress,
	code: 'node_unavailable' | 'consumer_unavailable' | 'provider_unavailable',
): PluginRouteCatalogEntry {
	const entry = pluginCatalogEntry(catalog, node.definition)
	if (!entry || (node.variant === 'fork' && !isDurableFork(state, node))) {
		reject({ code, node, message: `${nodeRole(code)} is unavailable in durable runtime state` })
	}
	if (node.variant === 'fork' && !entry.candidate.declaration.forkable) {
		reject({ code: 'not_forkable', node, message: 'Plugin definition does not allow fork nodes' })
	}
	return entry
}

function isDurableFork(
	state: AdmissionState,
	node: PluginNodeAddress,
): node is Extract<PluginNodeAddress, { variant: 'fork' }> {
	return (
		node.variant === 'fork' &&
		state.forks.get(pluginDefinitionIndexKey(node.definition))?.forkIds.has(node.forkId) === true
	)
}

function overrideKey(consumer: PluginNodeAddress, requirement: PluginDefinitionAddress): string {
	return `${pluginNodeIndexKey(consumer)}:${pluginDefinitionIndexKey(requirement)}`
}

function setOverride(state: AdmissionState, override: RuntimeDependencyOverrideState): void {
	const key = overrideKey(override.consumerAddress, override.requirementAddress)
	removeOverride(state, key)
	state.dependencyOverrides.set(key, override)
	addIndex(state.overridesByProvider, pluginNodeIndexKey(override.providerAddress), key)
	addIndex(state.overridesByConsumer, pluginNodeIndexKey(override.consumerAddress), key)
}

function removeOverride(state: AdmissionState, key: string): void {
	const previous = state.dependencyOverrides.get(key)
	if (!previous) return
	state.dependencyOverrides.delete(key)
	deleteIndex(state.overridesByProvider, pluginNodeIndexKey(previous.providerAddress), key)
	deleteIndex(state.overridesByConsumer, pluginNodeIndexKey(previous.consumerAddress), key)
}

function addIndex(index: Map<string, Set<string>>, addressKey: string, override: string): void {
	const entries = index.get(addressKey) ?? new Set<string>()
	entries.add(override)
	index.set(addressKey, entries)
}

function deleteIndex(index: Map<string, Set<string>>, addressKey: string, override: string): void {
	const entries = index.get(addressKey)
	if (!entries) return
	entries.delete(override)
	if (entries.size === 0) index.delete(addressKey)
}

function providerCompatible(
	entry: PluginRouteCatalogEntry,
	requirement: PluginDefinitionAddress,
): boolean {
	return (
		pluginDefinitionAddressEqual(entry.address, requirement) ||
		(!!entry.candidate.declaration.provides &&
			pluginDefinitionAddressEqual(entry.candidate.declaration.provides, requirement))
	)
}

function nodeRole(
	code: 'node_unavailable' | 'consumer_unavailable' | 'provider_unavailable',
): string {
	switch (code) {
		case 'consumer_unavailable':
			return 'Consumer'
		case 'provider_unavailable':
			return 'Provider'
		case 'node_unavailable':
			return 'Plugin node'
	}
}

function reject(issue: RuntimeStateMutationRejection): never {
	throw new RuntimeStateMutationRejectedError(Object.freeze(issue))
}

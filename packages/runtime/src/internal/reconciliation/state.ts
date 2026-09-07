import {
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	freezeTrustedRuntimeStateSnapshot,
	type RuntimeDependencyOverrideState,
	type RuntimeForkState,
	type RuntimeProviderDefaultState,
	type RuntimeStateSnapshot,
} from '../../services/RuntimeStateStore'

export type RuntimeStatePatchOperation =
	| Readonly<{ type: 'set-auto-start'; node: PluginNodeAddress; autoStart: boolean }>
	| Readonly<{
			type: 'ensure-fork'
			definition: PluginDefinitionAddress
			forkId: string
	  }>
	| Readonly<{
			type: 'remove-fork'
			definition: PluginDefinitionAddress
			forkId: string
	  }>
	| Readonly<{
			type: 'set-provider-default'
			token: PluginDefinitionAddress
			provider: PluginNodeAddress | null
	  }>
	| Readonly<{
			type: 'set-dependency-override'
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress | null
	  }>
	| Readonly<{ type: 'remove-node-policy'; node: PluginNodeAddress }>

export type RuntimeStatePatch = Readonly<{
	operations: readonly RuntimeStatePatchOperation[]
}>

export const EMPTY_RUNTIME_STATE_PATCH: RuntimeStatePatch = Object.freeze({
	operations: Object.freeze([]),
})

export function runtimeStatePatch(
	...operations: readonly RuntimeStatePatchOperation[]
): RuntimeStatePatch {
	return Object.freeze({ operations: Object.freeze([...operations]) })
}

export function appendRuntimeStatePatch(
	left: RuntimeStatePatch | undefined,
	right: RuntimeStatePatch | undefined,
): RuntimeStatePatch | undefined {
	if (!left || left.operations.length === 0) return right
	if (!right || right.operations.length === 0) return left
	return runtimeStatePatch(...left.operations, ...right.operations)
}

export function applyRuntimeStatePatch(
	state: RuntimeStateSnapshot,
	patch: RuntimeStatePatch | undefined,
): RuntimeStateSnapshot {
	if (!patch || patch.operations.length === 0) return state

	const autoStart = new Map(state.autoStart.map((node) => [pluginNodeIndexKey(node), node]))
	const forks = new Map(
		state.forks.map((entry) => [
			pluginDefinitionIndexKey(entry.definition),
			{ definition: entry.definition, forkIds: new Set(entry.forkIds) },
		]),
	)
	const providerDefaults = new Map(
		state.providerDefaults.map((entry) => [pluginDefinitionIndexKey(entry.token), entry]),
	)
	const dependencyOverrides = new Map(
		state.dependencyOverrides.map((entry) => [overrideKey(entry), entry]),
	)
	const overrideKeysByConsumer = new Map<string, Set<string>>()
	for (const entry of state.dependencyOverrides) {
		addIndex(overrideKeysByConsumer, pluginNodeIndexKey(entry.consumerAddress), overrideKey(entry))
	}
	const deleteOverride = (key: string): void => {
		const previous = dependencyOverrides.get(key)
		if (!previous) return
		dependencyOverrides.delete(key)
		deleteIndex(overrideKeysByConsumer, pluginNodeIndexKey(previous.consumerAddress), key)
	}

	for (const operation of patch.operations) {
		switch (operation.type) {
			case 'set-auto-start': {
				const key = pluginNodeIndexKey(operation.node)
				if (operation.autoStart) autoStart.set(key, operation.node)
				else autoStart.delete(key)
				break
			}
			case 'ensure-fork': {
				const key = pluginDefinitionIndexKey(operation.definition)
				const family = forks.get(key) ?? {
					definition: operation.definition,
					forkIds: new Set<string>(),
				}
				family.forkIds.add(operation.forkId)
				forks.set(key, family)
				break
			}
			case 'remove-fork': {
				const key = pluginDefinitionIndexKey(operation.definition)
				const family = forks.get(key)
				if (!family) break
				family.forkIds.delete(operation.forkId)
				if (family.forkIds.size === 0) forks.delete(key)
				break
			}
			case 'set-provider-default': {
				const key = pluginDefinitionIndexKey(operation.token)
				if (operation.provider) {
					providerDefaults.set(key, {
						token: operation.token,
						provider: operation.provider,
					})
				} else {
					providerDefaults.delete(key)
				}
				break
			}
			case 'set-dependency-override': {
				const key = overrideKey({
					consumerAddress: operation.consumer,
					requirementAddress: operation.requirement,
				})
				if (operation.provider) {
					const next = {
						consumerAddress: operation.consumer,
						requirementAddress: operation.requirement,
						providerAddress: operation.provider,
					}
					dependencyOverrides.set(key, next)
					addIndex(overrideKeysByConsumer, pluginNodeIndexKey(operation.consumer), key)
				} else {
					deleteOverride(key)
				}
				break
			}
			case 'remove-node-policy': {
				const nodeKey = pluginNodeIndexKey(operation.node)
				autoStart.delete(nodeKey)
				for (const key of overrideKeysByConsumer.get(nodeKey) ?? []) {
					deleteOverride(key)
				}
				break
			}
		}
	}

	return freezeTrustedRuntimeStateSnapshot({
		autoStart: [...autoStart.values()],
		forks: [...forks.values()].map(({ definition, forkIds }) => ({
			definition,
			forkIds: [...forkIds],
		})),
		providerDefaults: [...providerDefaults.values()],
		dependencyOverrides: [...dependencyOverrides.values()],
	})
}

export function runtimeStateEqual(
	left: RuntimeStateSnapshot,
	right: RuntimeStateSnapshot,
): boolean {
	return (
		orderedKeysEqual(
			left.autoStart.map(pluginNodeIndexKey),
			right.autoStart.map(pluginNodeIndexKey),
		) &&
		orderedKeysEqual(left.forks.map(forkKey), right.forks.map(forkKey)) &&
		orderedKeysEqual(
			left.providerDefaults.map(providerKey),
			right.providerDefaults.map(providerKey),
		) &&
		orderedKeysEqual(
			left.dependencyOverrides.map(dependencyKey),
			right.dependencyOverrides.map(dependencyKey),
		)
	)
}

function overrideKey(
	entry: Pick<RuntimeDependencyOverrideState, 'consumerAddress' | 'requirementAddress'>,
): string {
	return `${pluginNodeIndexKey(entry.consumerAddress)}:${pluginDefinitionIndexKey(entry.requirementAddress)}`
}

function forkKey(entry: RuntimeForkState): string {
	return `${pluginDefinitionIndexKey(entry.definition)}:${entry.forkIds.join('\0')}`
}

function providerKey(entry: RuntimeProviderDefaultState): string {
	return `${pluginDefinitionIndexKey(entry.token)}:${pluginNodeIndexKey(entry.provider)}`
}

function dependencyKey(entry: RuntimeDependencyOverrideState): string {
	return `${overrideKey(entry)}:${pluginNodeIndexKey(entry.providerAddress)}`
}

function orderedKeysEqual(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false
	return left.every((value, index) => value === right[index])
}

function addIndex(index: Map<string, Set<string>>, address: string, key: string): void {
	const keys = index.get(address) ?? new Set<string>()
	keys.add(key)
	index.set(address, keys)
}

function deleteIndex(index: Map<string, Set<string>>, address: string, key: string): void {
	const keys = index.get(address)
	if (!keys) return
	keys.delete(key)
	if (keys.size === 0) index.delete(address)
}

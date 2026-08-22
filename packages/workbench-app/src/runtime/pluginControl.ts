import type { RpcStub } from 'capnweb'
import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type {
	BaseProviderInfo,
	ConfigResult,
	EnsureForkResult,
	RemoveForkResult,
	PluginDependencyRef,
	PluginDependencyMutationResult,
	PluginDependencyState,
	PluginStatusAction,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
	RuntimeRpcApi,
	SchemaResult,
} from '@pluxel/runtime/web'

export type RuntimeRpcStub = RpcStub<RuntimeRpcApi>

export async function getPluginSchema(
	rpc: RuntimeRpcStub,
	owner: PluginNodeAddress,
): Promise<SchemaResult> {
	return await rpc.pluginSchema(owner)
}

export async function getPluginConfig(
	rpc: RuntimeRpcStub,
	owner: PluginNodeAddress,
): Promise<ConfigResult> {
	return await rpc.pluginConfig(owner)
}

export async function patchPluginConfig(
	rpc: RuntimeRpcStub,
	owner: PluginNodeAddress,
	patch: Record<string, unknown>,
): Promise<ConfigResult> {
	return await rpc.patchPluginConfig(owner, patch)
}

export async function patchPluginConfigField(
	rpc: RuntimeRpcStub,
	input: {
		owner: PluginNodeAddress
		fieldPath: string
		value: unknown
	},
): Promise<ConfigResult> {
	return await rpc.patchPluginConfigField(input.owner, {
		fieldPath: input.fieldPath,
		value: input.value,
	})
}

export async function listPluginDependencies(
	rpc: RuntimeRpcStub,
	owner: PluginNodeAddress,
): Promise<PluginDependencyRef[]> {
	const result = await rpc.pluginDependencies(owner)
	if (result.ok === false) throw new Error(result.error)
	return result.items
}

export async function inspectPluginDependencies(
	rpc: RuntimeRpcStub,
	owner: PluginNodeAddress,
): Promise<PluginDependencyState[]> {
	const result = await rpc.inspectPluginDependencies(owner)
	if (result.ok === false) throw new Error(result.error)
	return result.items
}

export async function setPluginDependencyTarget(
	rpc: RuntimeRpcStub,
	input: {
		consumer: PluginNodeAddress
		index: number
		provider: PluginNodeAddress | null
	},
): Promise<PluginDependencyMutationResult> {
	return await rpc.setPluginDependencyTarget(input)
}

export async function inspectPluginBaseProvider(
	rpc: RuntimeRpcStub,
	owner: PluginNodeAddress,
): Promise<BaseProviderInfo | null> {
	const result = await rpc.inspectPluginBaseProvider(owner)
	if (result.ok === false) throw new Error(result.error)
	return result.value
}

export async function selectPluginBaseProvider(
	rpc: RuntimeRpcStub,
	input: {
		consumer: PluginNodeAddress
		token: PluginDefinitionAddress
		provider: PluginNodeAddress | null
	},
): Promise<PluginDependencyMutationResult> {
	return await rpc.selectPluginBaseProvider(input)
}

export async function ensurePluginFork(
	rpc: RuntimeRpcStub,
	input: {
		base: PluginNodeAddress
		forkId: string
		enable?: boolean
		selectFor?: {
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
		}
	},
): Promise<EnsureForkResult> {
	return await rpc.ensurePluginFork(input)
}

export async function removePluginFork(
	rpc: RuntimeRpcStub,
	input: {
		base: PluginNodeAddress
		forkId: string
	},
): Promise<RemoveForkResult> {
	return await rpc.removePluginFork(input)
}

export async function applyPluginStatusActions(
	rpc: RuntimeRpcStub,
	actions: PluginStatusBatchAction[],
): Promise<PluginStatusBatchResult> {
	return await rpc.applyPluginStatusActions(actions)
}

export async function runPluginStatusAction(
	rpc: RuntimeRpcStub,
	address: PluginNodeAddress,
	action: PluginStatusAction,
): Promise<import('@pluxel/runtime/web').PluginStatusMutationResult> {
	const result = await rpc.applyPluginStatusActions([{ address, action }])
	const first = result.results[0]
	if (!first) throw new Error('Runtime omitted the Plugin status mutation result')
	return first
}

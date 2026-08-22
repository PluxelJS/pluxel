import type { RpcStub } from 'capnweb'
import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type {
	BaseProviderInfo,
	ConfigResult,
	EnsureForkResult,
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
	return await rpc.pluginDependencies(owner)
}

export async function inspectPluginDependencies(
	rpc: RuntimeRpcStub,
	owner: PluginNodeAddress,
): Promise<PluginDependencyState[]> {
	return await rpc.inspectPluginDependencies(owner)
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
	return await rpc.inspectPluginBaseProvider(owner)
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
	},
): Promise<EnsureForkResult> {
	return await rpc.ensurePluginFork(input)
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
): Promise<{
	ok: boolean
	address: PluginNodeAddress
	error?: string
	commitError?: string
}> {
	const result = await rpc.applyPluginStatusActions([{ address, action }])
	const first = result.results[0]
	return {
		ok: Boolean(first?.ok),
		address,
		error: first?.error,
		commitError: result.commitError,
	}
}

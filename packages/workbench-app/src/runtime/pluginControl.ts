import type { RpcStub } from 'capnweb'
import type { PluginDefinitionAddressSnapshot, PluginNodeAddressSnapshot } from '@pluxel/core'
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
	owner: PluginNodeAddressSnapshot,
): Promise<SchemaResult> {
	return await rpc.pluginSchema(owner)
}

export async function getPluginConfig(
	rpc: RuntimeRpcStub,
	owner: PluginNodeAddressSnapshot,
): Promise<ConfigResult> {
	return await rpc.pluginConfig(owner)
}

export async function patchPluginConfig(
	rpc: RuntimeRpcStub,
	owner: PluginNodeAddressSnapshot,
	patch: Record<string, unknown>,
): Promise<ConfigResult> {
	return await rpc.patchPluginConfig(owner, patch)
}

export async function patchPluginConfigField(
	rpc: RuntimeRpcStub,
	input: {
		owner: PluginNodeAddressSnapshot
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
	owner: PluginNodeAddressSnapshot,
): Promise<PluginDependencyRef[]> {
	return await rpc.pluginDependencies(owner)
}

export async function inspectPluginDependencies(
	rpc: RuntimeRpcStub,
	owner: PluginNodeAddressSnapshot,
): Promise<PluginDependencyState[]> {
	return await rpc.inspectPluginDependencies(owner)
}

export async function setPluginDependencyTarget(
	rpc: RuntimeRpcStub,
	input: {
		consumer: PluginNodeAddressSnapshot
		index: number
		provider: PluginNodeAddressSnapshot | null
	},
): Promise<PluginDependencyMutationResult> {
	return await rpc.setPluginDependencyTarget(input)
}

export async function inspectPluginBaseProvider(
	rpc: RuntimeRpcStub,
	owner: PluginNodeAddressSnapshot,
): Promise<BaseProviderInfo | null> {
	return await rpc.inspectPluginBaseProvider(owner)
}

export async function selectPluginBaseProvider(
	rpc: RuntimeRpcStub,
	input: {
		consumer: PluginNodeAddressSnapshot
		token: PluginDefinitionAddressSnapshot
		provider: PluginNodeAddressSnapshot | null
	},
): Promise<PluginDependencyMutationResult> {
	return await rpc.selectPluginBaseProvider(input)
}

export async function ensurePluginFork(
	rpc: RuntimeRpcStub,
	input: {
		base: PluginNodeAddressSnapshot
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
	address: PluginNodeAddressSnapshot,
	action: PluginStatusAction,
): Promise<{
	ok: boolean
	address: PluginNodeAddressSnapshot
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

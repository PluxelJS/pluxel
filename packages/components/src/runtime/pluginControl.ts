import type { RpcStub } from 'capnweb'
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
	name: string,
): Promise<SchemaResult> {
	return await rpc.pluginSchema(name)
}

export async function getPluginConfig(
	rpc: RuntimeRpcStub,
	name: string,
): Promise<ConfigResult> {
	return await rpc.pluginConfig(name)
}

export async function patchPluginConfig(
	rpc: RuntimeRpcStub,
	name: string,
	patch: Record<string, unknown>,
): Promise<ConfigResult> {
	return await rpc.patchPluginConfig(name, patch)
}

export async function patchPluginConfigField(
	rpc: RuntimeRpcStub,
	input: {
		name: string
		schemaKey: string
		fieldPath: string
		value: unknown
	},
): Promise<ConfigResult> {
	return await rpc.patchPluginConfigField(input.name, {
		schemaKey: input.schemaKey,
		fieldPath: input.fieldPath,
		value: input.value,
	})
}

export async function listPluginDependencies(
	rpc: RuntimeRpcStub,
	name: string,
): Promise<PluginDependencyRef[]> {
	return await rpc.pluginDependencies(name)
}

export async function inspectPluginDependencies(
	rpc: RuntimeRpcStub,
	name: string,
): Promise<PluginDependencyState[]> {
	return await rpc.inspectPluginDependencies(name)
}

export async function setPluginDependencyTarget(
	rpc: RuntimeRpcStub,
	input: {
		name: string
		index: number
		targetName: string | null
	},
): Promise<PluginDependencyMutationResult> {
	return await rpc.setPluginDependencyTarget(input)
}

export async function inspectPluginBaseProvider(
	rpc: RuntimeRpcStub,
	name: string,
): Promise<BaseProviderInfo | null> {
	return await rpc.inspectPluginBaseProvider(name)
}

export async function selectPluginBaseProvider(
	rpc: RuntimeRpcStub,
	input: {
		name: string
		baseToken: string
		providerName: string | null
	},
): Promise<PluginDependencyMutationResult> {
	return await rpc.selectPluginBaseProvider(input)
}

export async function ensurePluginFork(
	rpc: RuntimeRpcStub,
	input: {
		baseName: string
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
	name: string,
	action: PluginStatusAction,
): Promise<{ ok: boolean; name: string; error?: string; commitError?: string }> {
	const result = await rpc.applyPluginStatusActions([{ name, action }])
	const first = result.results[0]
	return {
		ok: Boolean(first?.ok),
		name,
		error: first?.error,
		commitError: result.commitError,
	}
}

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
	return (await rpc.opsInvoke('plugin.schema', { name })) as SchemaResult
}

export async function getPluginConfig(
	rpc: RuntimeRpcStub,
	name: string,
): Promise<ConfigResult> {
	return (await rpc.opsInvoke('plugin.config.get', { name })) as ConfigResult
}

export async function patchPluginConfig(
	rpc: RuntimeRpcStub,
	name: string,
	patch: Record<string, unknown>,
): Promise<ConfigResult> {
	return (await rpc.opsInvoke('plugin.config.patch', { name, patch })) as ConfigResult
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
	return (await rpc.opsInvoke('plugin.config.patch-field', input)) as ConfigResult
}

export async function listPluginDependencies(
	rpc: RuntimeRpcStub,
	name: string,
): Promise<PluginDependencyRef[]> {
	return (await rpc.opsInvoke('plugin.dependencies.list', { name })) as PluginDependencyRef[]
}

export async function inspectPluginDependencies(
	rpc: RuntimeRpcStub,
	name: string,
): Promise<PluginDependencyState[]> {
	return (await rpc.opsInvoke('plugin.dependencies.inspect', { name })) as PluginDependencyState[]
}

export async function setPluginDependencyTarget(
	rpc: RuntimeRpcStub,
	input: {
		name: string
		index: number
		targetName: string | null
	},
): Promise<PluginDependencyMutationResult> {
	return (await rpc.opsInvoke('plugin.dependencies.set-target', input)) as PluginDependencyMutationResult
}

export async function inspectPluginBaseProvider(
	rpc: RuntimeRpcStub,
	name: string,
): Promise<BaseProviderInfo | null> {
	return (await rpc.opsInvoke('plugin.base-provider.inspect', { name })) as BaseProviderInfo | null
}

export async function selectPluginBaseProvider(
	rpc: RuntimeRpcStub,
	input: {
		name: string
		baseToken: string
		providerName: string | null
	},
): Promise<PluginDependencyMutationResult> {
	return (await rpc.opsInvoke('plugin.base-provider.select', input)) as PluginDependencyMutationResult
}

export async function ensurePluginFork(
	rpc: RuntimeRpcStub,
	input: {
		baseName: string
		forkId: string
		enable?: boolean
	},
): Promise<EnsureForkResult> {
	return (await rpc.opsInvoke('plugin.fork.ensure', input)) as EnsureForkResult
}

export async function applyPluginStatusActions(
	rpc: RuntimeRpcStub,
	actions: PluginStatusBatchAction[],
): Promise<PluginStatusBatchResult> {
	return (await rpc.opsInvoke('plugins.status.apply', { actions })) as PluginStatusBatchResult
}

export async function runPluginStatusAction(
	rpc: RuntimeRpcStub,
	name: string,
	action: PluginStatusAction,
): Promise<{ ok: boolean; name: string; error?: string; commitError?: string }> {
	return (await rpc.opsInvoke(`plugin.${action}`, { name })) as {
		ok: boolean
		name: string
		error?: string
		commitError?: string
	}
}

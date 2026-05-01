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

function unwrapOpResult<T>(result: unknown): T {
	if (result && typeof result === 'object' && 'ok' in result) {
		const current = result as { ok: boolean; value?: T; error?: { publicMessage?: string; message?: string } }
		if (current.ok) return current.value as T
		throw new Error(current.error?.publicMessage ?? current.error?.message ?? 'Operation failed')
	}
	throw new Error('Invalid operation result')
}

export async function getPluginSchema(
	rpc: RuntimeRpcStub,
	name: string,
): Promise<SchemaResult> {
	return unwrapOpResult<SchemaResult>(await rpc.opsInvoke('plugin.schema', { name }))
}

export async function getPluginConfig(
	rpc: RuntimeRpcStub,
	name: string,
): Promise<ConfigResult> {
	return unwrapOpResult<ConfigResult>(await rpc.opsInvoke('plugin.config.get', { name }))
}

export async function patchPluginConfig(
	rpc: RuntimeRpcStub,
	name: string,
	patch: Record<string, unknown>,
): Promise<ConfigResult> {
	return unwrapOpResult<ConfigResult>(await rpc.opsInvoke('plugin.config.patch', { name, patch }))
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
	return unwrapOpResult<ConfigResult>(await rpc.opsInvoke('plugin.config.patch-field', input))
}

export async function listPluginDependencies(
	rpc: RuntimeRpcStub,
	name: string,
): Promise<PluginDependencyRef[]> {
	return unwrapOpResult<PluginDependencyRef[]>(await rpc.opsInvoke('plugin.dependencies.list', { name }))
}

export async function inspectPluginDependencies(
	rpc: RuntimeRpcStub,
	name: string,
): Promise<PluginDependencyState[]> {
	return unwrapOpResult<PluginDependencyState[]>(await rpc.opsInvoke('plugin.dependencies.inspect', { name }))
}

export async function setPluginDependencyTarget(
	rpc: RuntimeRpcStub,
	input: {
		name: string
		index: number
		targetName: string | null
	},
): Promise<PluginDependencyMutationResult> {
	return unwrapOpResult<PluginDependencyMutationResult>(await rpc.opsInvoke('plugin.dependencies.set-target', input))
}

export async function inspectPluginBaseProvider(
	rpc: RuntimeRpcStub,
	name: string,
): Promise<BaseProviderInfo | null> {
	return unwrapOpResult<BaseProviderInfo | null>(await rpc.opsInvoke('plugin.base-provider.inspect', { name }))
}

export async function selectPluginBaseProvider(
	rpc: RuntimeRpcStub,
	input: {
		name: string
		baseToken: string
		providerName: string | null
	},
): Promise<PluginDependencyMutationResult> {
	return unwrapOpResult<PluginDependencyMutationResult>(await rpc.opsInvoke('plugin.base-provider.select', input))
}

export async function ensurePluginFork(
	rpc: RuntimeRpcStub,
	input: {
		baseName: string
		forkId: string
		enable?: boolean
	},
): Promise<EnsureForkResult> {
	return unwrapOpResult<EnsureForkResult>(await rpc.opsInvoke('plugin.fork.ensure', input))
}

export async function applyPluginStatusActions(
	rpc: RuntimeRpcStub,
	actions: PluginStatusBatchAction[],
): Promise<PluginStatusBatchResult> {
	return unwrapOpResult<PluginStatusBatchResult>(await rpc.opsInvoke('plugins.status.apply', { actions }))
}

export async function runPluginStatusAction(
	rpc: RuntimeRpcStub,
	name: string,
	action: PluginStatusAction,
): Promise<{ ok: boolean; name: string; error?: string; commitError?: string }> {
	return unwrapOpResult<{
		ok: boolean
		name: string
		error?: string
		commitError?: string
	}>(await rpc.opsInvoke(`plugin.${action}`, { name }))
}

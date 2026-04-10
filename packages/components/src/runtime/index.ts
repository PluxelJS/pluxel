import {
	createAuthAwareFetch,
	createRuntimeTransportClient,
	dispatchRuntimeCommand,
	invokeRpc,
	invokeRuntimeOp,
	listRuntimeOps,
	rpcErrorMessage,
	RuntimeTransportClientProvider,
	useRuntimeTransportClient,
} from '@pluxel/runtime/web'
export * from './ops'

export {
	createAuthAwareFetch,
	dispatchRuntimeCommand,
	invokeRpc,
	invokeRuntimeOp,
	listRuntimeOps,
	rpcErrorMessage,
	RuntimeTransportClientProvider,
	useRuntimeTransportClient,
}

export type {
	BaseProviderInfo,
	ConfigResult,
	ConfigResultErr,
	ConfigResultOk,
	EnsureForkResult,
	LogFilter,
	LogLevel,
	LogRangeOk,
	LogSseEvent,
	LogStreamMeta,
	PackageBatchResult,
	PackageInventoryEntry,
	PackageInventoryFilter,
	PackageIssueSpec,
	PackageLoadIssue,
	PackageSpecInput,
	PluginDependencyRef,
	PluginDependencyMutationResult,
	PluginDependencyState,
	PluginGroup,
	PluginGroupInput,
	PluginLevelsSnapshot,
	PluginLogLevel,
	PluginStatusAction,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
	PluginStatusMutationResult,
	RuntimeOpDescriptor,
	RuntimeLogLine,
	RuntimeRpcApi,
	RuntimeTransportClient,
	SchemaResult,
	SchemaResultErr,
	SchemaResultOk,
} from '@pluxel/runtime/web'

let transport: ReturnType<typeof createRuntimeTransportClient> | null = null

/**
 * Host-wide runtime transport singleton.
 *
 * Non-React code and the root provider must share the same client instance so
 * SSE connections, auth probing, and transport caches stay deterministic.
 */
export function getRuntimeTransportClient() {
	if (!transport) {
		transport = createRuntimeTransportClient({
			fetch: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
		})
	}

	return transport
}

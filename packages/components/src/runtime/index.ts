import {
	createAuthAwareFetch,
	createRuntimeTransportClient,
	dispatchRuntimeCommand,
	invokeRpc,
	invokeRuntimeOp,
	listRuntimeOpCatalog,
	listRuntimeOpsToolsets,
	listRuntimeOps,
	rpcErrorMessage,
	RuntimeTransportClientProvider,
	resolveRuntimeOpsToolset,
	updateRuntimeOpsToolsets,
	useRuntimeTransportClient,
} from '@pluxel/runtime/web'
export * from './ops'

export {
	createAuthAwareFetch,
	dispatchRuntimeCommand,
	invokeRpc,
	invokeRuntimeOp,
	listRuntimeOpCatalog,
	listRuntimeOpsToolsets,
	listRuntimeOps,
	rpcErrorMessage,
	RuntimeTransportClientProvider,
	resolveRuntimeOpsToolset,
	updateRuntimeOpsToolsets,
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
	OpsToolset,
	OpsToolsetInput,
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
	RuntimeOpCatalogEntry,
	RuntimeOpDescriptor,
	RuntimeOpToolsetManifest,
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

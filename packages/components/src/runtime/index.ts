import {
	createAuthAwareFetch,
	createRuntimeTransportClient,
	invokeRpc,
	rpcErrorMessage,
	RuntimeTransportClientProvider,
	useRuntimeTransportClient,
} from '@pluxel/runtime/web'

export {
	createAuthAwareFetch,
	invokeRpc,
	rpcErrorMessage,
	RuntimeTransportClientProvider,
	useRuntimeTransportClient,
}

export type {
	BaseProvisionInfo,
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
	PluginDependencyState,
	PluginGroup,
	PluginGroupInput,
	PluginLevelsSnapshot,
	PluginLogLevel,
	PluginStatusAction,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
	PluginStatusMutationResult,
	RuntimeLogLine,
	RuntimeRpcApi,
	RuntimeTransportClient,
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

import {
	createAdminAccessAwareFetch,
	createRuntimeTransportClient,
	createRuntimeSecurityClient,
	RUNTIME_SECURITY_BASE,
	RUNTIME_ADMIN_ACCESS_BASE,
	invokeRpc,
	rpcErrorMessage,
	resolveAdminAccessLandingPath,
	RuntimeTransportClientProvider,
	useRuntimeTransportClient,
} from '@pluxel/runtime/web'
export * from './pluginControl'

export {
	createAdminAccessAwareFetch,
	createRuntimeSecurityClient,
	RUNTIME_SECURITY_BASE,
	RUNTIME_ADMIN_ACCESS_BASE,
	invokeRpc,
	rpcErrorMessage,
	resolveAdminAccessLandingPath,
	RuntimeTransportClientProvider,
	useRuntimeTransportClient,
}

export type {
	AgentToolAssignment,
	AgentToolsAdminSnapshot,
	AgentToolsHandleApi,
	AgentToolsPolicy,
	AgentToolsPolicyInput,
	BaseProviderInfo,
	ConfigResult,
	ConfigResultErr,
	ConfigResultOk,
	CommandInventoryItem,
	CommandToolset,
	EnsureForkResult,
	LogFilter,
	LogLevel,
	LogRangeOk,
	LogSseEvent,
	LogStreamMeta,
	AdminAccessAwareFetchOptions,
	AdminAccessBlockedInfo,
	PluginDependencyRef,
	PluginDependencyMutationResult,
	PluginDependencyState,
	PluginGroup,
	PluginGroupInput,
	PluginLogPolicySnapshot,
	PluginLogPolicyMutationResult,
	VersionedPluginLogPolicySnapshot,
	PluginStatusAction,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
	PluginStatusMutationResult,
	RuntimePluginLogLevel,
	SecurityAuditEvent,
	SecurityOverview,
	AdminAccessOverview,
	RuntimeLogLine,
	RuntimeRpcApi,
	RuntimeTransportClient,
	RuntimeSecurityClient,
	VaultAdminState,
	VaultKeyPair,
	OnAdminAccessBlocked,
	SchemaResult,
	SchemaResultErr,
	SchemaResultOk,
} from '@pluxel/runtime/web'

let transport: ReturnType<typeof createRuntimeTransportClient> | null = null
let security: ReturnType<typeof createRuntimeSecurityClient> | null = null

/**
 * Host-wide runtime transport singleton.
 *
 * Non-React code and the root provider must share the same client instance so
 * SSE connections, admin access probing, and transport caches stay deterministic.
 */
export function getRuntimeTransportClient() {
	if (!transport) {
		transport = createRuntimeTransportClient({
			fetch: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
		})
	}

	return transport
}

export function getRuntimeSecurityClient() {
	if (!security) {
		const runtime = getRuntimeTransportClient()
		security = createRuntimeSecurityClient({
			apiBase: runtime.links.apiBase,
			fetch: runtime.fetch,
		})
	}

	return security
}

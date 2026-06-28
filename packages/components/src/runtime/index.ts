import {
	createVerificationAwareFetch,
	createRuntimeTransportClient,
	createRuntimeSecurityClient,
	HMR_SECURITY_BASE,
	HMR_VERIFICATION_BASE,
	invokeRpc,
	rpcErrorMessage,
	resolveVerificationLandingPath,
	RuntimeTransportClientProvider,
	useRuntimeTransportClient,
} from '@pluxel/runtime/web'
export * from './pluginControl'

export {
	createVerificationAwareFetch,
	createRuntimeSecurityClient,
	HMR_SECURITY_BASE,
	HMR_VERIFICATION_BASE,
	invokeRpc,
	rpcErrorMessage,
	resolveVerificationLandingPath,
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
	PluginLogPolicySnapshot,
	PluginStatusAction,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
	PluginStatusMutationResult,
	RuntimePluginLogLevel,
	SecurityAuditEvent,
	SecurityOverview,
	VerificationOverview,
	RuntimeLogLine,
	RuntimeRpcApi,
	RuntimeTransportClient,
	RuntimeSecurityClient,
	VaultAdminState,
	VaultKeyPair,
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
 * SSE connections, verification probing, and transport caches stay deterministic.
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

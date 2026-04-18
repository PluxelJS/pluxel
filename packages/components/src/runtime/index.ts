import {
	createVerificationAwareFetch,
	createRuntimeTransportClient,
	createRuntimeSecurityClient,
	dispatchRuntimeCommand,
	HMR_SECURITY_BASE,
	HMR_VERIFICATION_BASE,
	invokeRpc,
	invokeRuntimeOp,
	listRuntimeOpCatalog,
	listRuntimeOpsToolsets,
	listRuntimeOps,
	rpcErrorMessage,
	resolveVerificationLandingPath,
	RuntimeTransportClientProvider,
	resolveRuntimeOpsToolset,
	updateRuntimeOpsToolsets,
	useRuntimeTransportClient,
} from '@pluxel/runtime/web'
export * from './ops'

export {
	createVerificationAwareFetch,
	createRuntimeSecurityClient,
	dispatchRuntimeCommand,
	HMR_SECURITY_BASE,
	HMR_VERIFICATION_BASE,
	invokeRpc,
	invokeRuntimeOp,
	listRuntimeOpCatalog,
	listRuntimeOpsToolsets,
	listRuntimeOps,
	rpcErrorMessage,
	resolveVerificationLandingPath,
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
	SecurityAuditEvent,
	SecurityOverview,
	VerificationAdminState,
	VerificationOtpProvisionResult,
	VerificationOtpUserProvisionInput,
	VerificationPasskeyRegistrationFinishInput,
	VerificationPasskeyRegistrationOptions,
	VerificationPasskeyRegistrationStartInput,
	VerificationPasswordUserUpsertInput,
	VerificationUserDeleteInput,
	RuntimeOpToolsetManifest,
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

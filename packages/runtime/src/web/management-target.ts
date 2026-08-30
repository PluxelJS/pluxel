import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type { RpcTarget } from '../capnweb'
import type { SecurityAuditEvent, SecurityOverview } from './security'
import type { LogFilter, LogRangeResult, LogStreamMeta } from './logs'
import type {
	AgentToolsHandleApi,
	ConfigFieldMutation,
	ConfigPresentationResult,
	ConfigResult,
	EnsureForkResult,
	LoggingHandleApi,
	PluginDependencyGraphSnapshot,
	PluginConsumerRequirementsInspectionResult,
	PluginDependencyMutationResult,
	PluginProviderPolicyInspectionResult,
	PluginCatalogLayoutInput,
	PluginCatalogLayoutMutationResult,
	PluginCatalogSnapshot,
	PluginAutoStartBatchItem,
	PluginControlBatchResult,
	PluginLifecycleCommandBatchItem,
	PluginStatusQueryResult,
	RemoveForkResult,
	RuntimeMeta,
	VaultKeyPair,
} from './protocol'
import type { VaultAdminState } from '../services/vault/types'

export type RuntimeLogStreamsIndex = Readonly<{ streams: readonly LogStreamMeta[] }>

export type RuntimeLogRangeQuery = Readonly<{
	epoch: number
	fromSeq: string
	limit?: number
	filter?: LogFilter
}>

export type RuntimeLogFollowInput = Readonly<{
	streamId: string
	filter?: LogFilter
}>

export type RuntimeLogObserver = (event: unknown) => Promise<void>

/** Disposal is the only cancellation operation for a live log subscription. */
export interface RuntimeLogSubscriptionTarget extends RpcTarget {}

/** Authenticated, connection-bound Management capability for the current protocol major. */
export interface RuntimeManagementTarget extends RpcTarget {
	describe: () => RuntimeMeta | Promise<RuntimeMeta>
	pluginCatalog: () => Promise<PluginCatalogSnapshot>
	updatePluginCatalogLayout: (
		input: PluginCatalogLayoutInput,
	) => Promise<PluginCatalogLayoutMutationResult>
	pluginStatus: (owner: PluginNodeAddress) => Promise<PluginStatusQueryResult>
	pluginConfigPresentation: (owner: PluginNodeAddress) => Promise<ConfigPresentationResult>
	pluginConfig: (owner: PluginNodeAddress) => Promise<ConfigResult>
	patchPluginConfig: (
		owner: PluginNodeAddress,
		patch: Record<string, unknown>,
	) => Promise<ConfigResult>
	patchPluginConfigField: (
		owner: PluginNodeAddress,
		input: ConfigFieldMutation,
	) => Promise<ConfigResult>
	pluginDependencyGraph: () => Promise<PluginDependencyGraphSnapshot>
	inspectPluginConsumerRequirements: (
		consumer: PluginNodeAddress,
	) => Promise<PluginConsumerRequirementsInspectionResult>
	setPluginConsumerOverride: (input: {
		consumer: PluginNodeAddress
		requirement: PluginDefinitionAddress
		provider: PluginNodeAddress | null
	}) => Promise<PluginDependencyMutationResult>
	inspectPluginProviderPolicy: (
		policyOwner: PluginNodeAddress,
	) => Promise<PluginProviderPolicyInspectionResult>
	setPluginProviderPolicyDefault: (input: {
		policyOwner: PluginNodeAddress
		provider: PluginNodeAddress | null
	}) => Promise<PluginDependencyMutationResult>
	ensurePluginFork: (input: {
		base: PluginNodeAddress
		forkId: string
		autoStart?: boolean
		selectFor?: {
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
		}
	}) => Promise<EnsureForkResult>
	removePluginFork: (input: {
		base: PluginNodeAddress
		forkId: string
	}) => Promise<RemoveForkResult>
	setPluginAutoStart: (items: PluginAutoStartBatchItem[]) => Promise<PluginControlBatchResult>
	applyPluginLifecycleCommands: (
		items: PluginLifecycleCommandBatchItem[],
	) => Promise<PluginControlBatchResult>

	getLogPolicy: LoggingHandleApi['getPolicy']
	replaceLogPolicy: LoggingHandleApi['replacePolicy']
	setDefaultLogLevel: LoggingHandleApi['setDefaultLevel']
	setPluginLogLevel: LoggingHandleApi['setPluginLevel']
	clearPluginLogLevel: LoggingHandleApi['clearPluginLevel']
	resetLogPolicy: LoggingHandleApi['resetPolicy']
	logStreams: () => RuntimeLogStreamsIndex | Promise<RuntimeLogStreamsIndex>
	logMeta: (streamId: unknown) => LogStreamMeta | Promise<LogStreamMeta>
	logRange: (streamId: unknown, query: unknown) => LogRangeResult | Promise<LogRangeResult>
	followLogs: (
		input: unknown,
		observer: RuntimeLogObserver,
	) => RuntimeLogSubscriptionTarget | Promise<RuntimeLogSubscriptionTarget>

	agentToolsSnapshot: AgentToolsHandleApi['snapshot']
	replaceAgentToolsPolicy: AgentToolsHandleApi['replacePolicy']

	securityOverview: () => SecurityOverview | Promise<SecurityOverview>
	securityEvents: (
		limit?: unknown,
	) => readonly SecurityAuditEvent[] | Promise<readonly SecurityAuditEvent[]>
	vaultUnlock: () => VaultAdminState | Promise<VaultAdminState>
	vaultEnsureHostKey: () =>
		| Readonly<{ publicKey: string }>
		| Promise<Readonly<{ publicKey: string }>>
	vaultGenerateDeployKey: () => VaultKeyPair | Promise<VaultKeyPair>
	vaultSetDeployRecipients: (publicKeys: unknown) => VaultAdminState | Promise<VaultAdminState>
}

import type { RuntimeUpdateSnapshot } from '@pluxel/host/internal/protocol'
import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type { RpcTarget } from 'capnweb'
import type { SecurityAuditEvent, SecurityOverview } from './security'
import type { LogFilter, LogRangeResult, LogStreamMeta } from '../../logging/protocol'
import type {
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
import type { VaultAdminState } from '../../vault'

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

/** Disposal is the only cancellation operation for a live Management subscription. */
export interface RuntimeSubscriptionTarget extends RpcTarget {}

/**
 * Authenticated, connection-bound Management capability for the current protocol major.
 * Every *Dto method returns a validated portable snapshot without nested capabilities.
 * Subscription methods return owned resources and deliberately have no Dto suffix.
 */
export interface RuntimeManagementTarget extends RpcTarget {
	describeDto: () => RuntimeMeta | Promise<RuntimeMeta>
	runtimeUpdateDto: () => RuntimeUpdateSnapshot | null
	followRuntimeUpdates: (
		observer: (snapshot: unknown) => Promise<void>,
	) => RuntimeSubscriptionTarget
	pluginCatalogDto: () => Promise<PluginCatalogSnapshot>
	updatePluginCatalogLayoutDto: (
		input: PluginCatalogLayoutInput,
	) => Promise<PluginCatalogLayoutMutationResult>
	pluginStatusDto: (owner: PluginNodeAddress) => Promise<PluginStatusQueryResult>
	pluginConfigPresentationDto: (owner: PluginNodeAddress) => Promise<ConfigPresentationResult>
	pluginConfigDto: (owner: PluginNodeAddress) => Promise<ConfigResult>
	patchPluginConfigDto: (
		owner: PluginNodeAddress,
		patch: Record<string, unknown>,
	) => Promise<ConfigResult>
	patchPluginConfigFieldDto: (
		owner: PluginNodeAddress,
		input: ConfigFieldMutation,
	) => Promise<ConfigResult>
	pluginDependencyGraphDto: () => Promise<PluginDependencyGraphSnapshot>
	inspectPluginConsumerRequirementsDto: (
		consumer: PluginNodeAddress,
	) => Promise<PluginConsumerRequirementsInspectionResult>
	setPluginConsumerOverrideDto: (input: {
		consumer: PluginNodeAddress
		requirement: PluginDefinitionAddress
		provider: PluginNodeAddress | null
	}) => Promise<PluginDependencyMutationResult>
	inspectPluginProviderPolicyDto: (
		policyOwner: PluginNodeAddress,
	) => Promise<PluginProviderPolicyInspectionResult>
	setPluginProviderPolicyDefaultDto: (input: {
		policyOwner: PluginNodeAddress
		provider: PluginNodeAddress | null
	}) => Promise<PluginDependencyMutationResult>
	ensurePluginForkDto: (input: {
		base: PluginNodeAddress
		forkId: string
		autoStart?: boolean
		selectFor?: {
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
		}
	}) => Promise<EnsureForkResult>
	removePluginForkDto: (input: {
		base: PluginNodeAddress
		forkId: string
	}) => Promise<RemoveForkResult>
	setPluginAutoStartDto: (items: PluginAutoStartBatchItem[]) => Promise<PluginControlBatchResult>
	applyPluginLifecycleCommandsDto: (
		items: PluginLifecycleCommandBatchItem[],
	) => Promise<PluginControlBatchResult>

	getLogPolicyDto: LoggingHandleApi['getPolicy']
	replaceLogPolicyDto: LoggingHandleApi['replacePolicy']
	setDefaultLogLevelDto: LoggingHandleApi['setDefaultLevel']
	setPluginLogLevelDto: LoggingHandleApi['setPluginLevel']
	clearPluginLogLevelDto: LoggingHandleApi['clearPluginLevel']
	resetLogPolicyDto: LoggingHandleApi['resetPolicy']
	logStreamsDto: () => RuntimeLogStreamsIndex | Promise<RuntimeLogStreamsIndex>
	logMetaDto: (streamId: unknown) => LogStreamMeta | Promise<LogStreamMeta>
	logRangeDto: (streamId: unknown, query: unknown) => LogRangeResult | Promise<LogRangeResult>
	followLogs: (
		input: unknown,
		observer: RuntimeLogObserver,
	) => RuntimeSubscriptionTarget | Promise<RuntimeSubscriptionTarget>

	securityOverviewDto: () => SecurityOverview | Promise<SecurityOverview>
	securityEventsDto: (
		limit?: unknown,
	) => readonly SecurityAuditEvent[] | Promise<readonly SecurityAuditEvent[]>
	vaultUnlockDto: () => VaultAdminState | Promise<VaultAdminState>
	vaultEnsureHostKeyDto: () =>
		| Readonly<{ publicKey: string }>
		| Promise<Readonly<{ publicKey: string }>>
	vaultGenerateDeployKeyDto: () => VaultKeyPair | Promise<VaultKeyPair>
	vaultSetDeployRecipientsDto: (publicKeys: unknown) => VaultAdminState | Promise<VaultAdminState>
}

import type { HostConfigState, HostPolicyInput, HostPolicyField } from '@pluxel/host'
import { type RuntimeUpdateSnapshot } from '@pluxel/host/internal/protocol'
import {
	type PluginDefinitionAddress,
	type PluginForkNodeAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { type RpcTarget } from 'capnweb'
import { type SecurityAuditEvent, type SecurityOverview } from './security'
import {
	type LogFilter,
	type LogRangeResult,
	type LogStreamMeta,
} from '@pluxel/core/logging/protocol'
import {
	type ConfigFieldMutation,
	type ConfigPatch,
	type ManagedInputMutationOptions,
	type ConfigPresentationResult,
	type ConfigResult,
	type PolicyResult,
	type EnsureForkResult,
	type LoggingHandleApi,
	type PluginDependencyGraphSnapshot,
	type PluginConsumerRequirementsInspectionResult,
	type PluginDependencyMutationResult,
	type PluginProviderPolicyInspectionResult,
	type PluginCatalogLayoutInput,
	type PluginCatalogLayoutMutationResult,
	type PluginCatalogSnapshot,
	type PluginAutoStartBatchItem,
	type PluginControlBatchResult,
	type PluginLifecycleCommandBatchItem,
	type PluginStatusQueryResult,
	type RemoveForkResult,
	type RuntimeMeta,
	type VaultKeyPair,
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
	configStateDto: () => HostConfigState
	hostPolicyDto: () => Promise<PolicyResult>
	validateHostPolicyDto: (values: HostPolicyInput) => Promise<PolicyResult>
	patchHostPolicyDto: (
		values: HostPolicyInput,
		options?: ManagedInputMutationOptions,
	) => Promise<PolicyResult>
	resetHostPolicyDto: (
		keys?: readonly HostPolicyField[],
		options?: ManagedInputMutationOptions,
	) => Promise<PolicyResult>
	pluginConfigDto: (owner: PluginNodeAddress) => Promise<ConfigResult>
	patchPluginConfigDto: (
		owner: PluginNodeAddress,
		patch: ConfigPatch,
		options?: ManagedInputMutationOptions,
	) => Promise<ConfigResult>
	validatePluginConfigDto: (
		owner: PluginNodeAddress,
		patch: ConfigPatch,
		options?: ManagedInputMutationOptions,
	) => Promise<ConfigResult>
	resetPluginConfigDto: (
		owner: PluginNodeAddress,
		paths?: readonly (readonly string[])[],
		options?: ManagedInputMutationOptions,
	) => Promise<ConfigResult>
	patchPluginConfigFieldDto: (
		owner: PluginNodeAddress,
		input: ConfigFieldMutation,
		options?: ManagedInputMutationOptions,
	) => Promise<ConfigResult>
	pluginDependencyGraphDto: () => Promise<PluginDependencyGraphSnapshot>
	inspectPluginConsumerRequirementsDto: (
		consumer: PluginNodeAddress,
	) => Promise<PluginConsumerRequirementsInspectionResult>
	setPluginConsumerOverrideDto: (
		input: {
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress | null
		},
		options?: ManagedInputMutationOptions,
	) => Promise<PluginDependencyMutationResult>
	inspectPluginProviderPolicyDto: (
		policyOwner: PluginNodeAddress,
	) => Promise<PluginProviderPolicyInspectionResult>
	setPluginProviderPolicyDefaultDto: (
		input: {
			policyOwner: PluginNodeAddress
			provider: PluginNodeAddress | null
		},
		options?: ManagedInputMutationOptions,
	) => Promise<PluginDependencyMutationResult>
	ensurePluginForkDto: (
		input: {
			fork: PluginForkNodeAddress
			autoStart?: boolean
			selectFor?: {
				consumer: PluginNodeAddress
				requirement: PluginDefinitionAddress
			}
		},
		options?: ManagedInputMutationOptions,
	) => Promise<EnsureForkResult>
	removePluginForkDto: (
		fork: PluginForkNodeAddress,
		options?: ManagedInputMutationOptions,
	) => Promise<RemoveForkResult>
	setPluginAutoStartDto: (
		items: PluginAutoStartBatchItem[],
		options?: ManagedInputMutationOptions,
	) => Promise<PluginControlBatchResult>
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

import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
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
	PluginGroup,
	PluginGroupInput,
	PluginGroupsMutationResult,
	PluginAutoStartBatchItem,
	PluginControlBatchResult,
	PluginLifecycleCommandBatchItem,
	PluginStatusQueryResult,
	PluginsListOutput,
	RemoveForkResult,
} from './protocol'

/** Private wire shape consumed by the Level 1 domain client. */
export type RuntimeManagementRpcApi = {
	pluginsList: () => Promise<PluginsListOutput>
	pluginStatus: (owner: PluginNodeAddress) => Promise<PluginStatusQueryResult>
	pluginGroups: () => Promise<readonly PluginGroup[]>
	logging: () => LoggingHandleApi
	agentTools: () => AgentToolsHandleApi
	updatePluginGroups: (groups: PluginGroupInput[]) => Promise<PluginGroupsMutationResult>
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
}

import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type {
	AgentToolsHandleApi,
	BaseProviderInspectionResult,
	ConfigFieldMutation,
	ConfigPresentationResult,
	ConfigResult,
	EnsureForkResult,
	LoggingHandleApi,
	PluginDependencyInspectionResult,
	PluginDependencyListResult,
	PluginDependencyMutationResult,
	PluginGroup,
	PluginGroupInput,
	PluginGroupsMutationResult,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
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
	pluginDependencies: (owner: PluginNodeAddress) => Promise<PluginDependencyListResult>
	inspectPluginDependencies: (owner: PluginNodeAddress) => Promise<PluginDependencyInspectionResult>
	setPluginDependencyTarget: (input: {
		consumer: PluginNodeAddress
		requirement: PluginDefinitionAddress
		provider: PluginNodeAddress | null
	}) => Promise<PluginDependencyMutationResult>
	inspectPluginBaseProvider: (owner: PluginNodeAddress) => Promise<BaseProviderInspectionResult>
	selectPluginBaseProvider: (input: {
		consumer: PluginNodeAddress
		token: PluginDefinitionAddress
		provider: PluginNodeAddress | null
	}) => Promise<PluginDependencyMutationResult>
	ensurePluginFork: (input: {
		base: PluginNodeAddress
		forkId: string
		enable?: boolean
		selectFor?: {
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
		}
	}) => Promise<EnsureForkResult>
	removePluginFork: (input: {
		base: PluginNodeAddress
		forkId: string
	}) => Promise<RemoveForkResult>
	applyPluginStatusActions: (actions: PluginStatusBatchAction[]) => Promise<PluginStatusBatchResult>
}

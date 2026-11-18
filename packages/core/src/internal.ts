export {
	assertOwnerInvocationOpen,
	closeOwnerInvocations,
	enterOwnerInvocation,
	type OwnerInvocationLease,
} from './internal/owner-invocations'

export { PluginSlotRegistry } from './plugins/runtime/identity'
export {
	CorePluginGraphVerificationError,
	PluginService,
	type CommittedPluginDependencyAdjacency,
	type CommittedPluginDependencyEdge,
} from './plugins/runtime/PluginService'
export {
	notifyRunningPluginConfigUpdate,
	type PluginConfigNotificationResult,
} from './plugins/runtime/plugin-service/ConfigUpdate'
export type { PreparedRuntimeUpdateCommitOptions } from './plugins/runtime/plugin-service/RuntimeUpdateTransaction'
export type {
	CoreCommitPublication,
	CoreGenerationFinalization,
	CoreGenerationRejection,
	CoreGenerationSettlement,
	CorePluginLifecycleHooks,
	CorePluginLifecycleOperation,
} from './plugins/runtime/plugin-service/HostLifecycle'
export {
	requirePluginGenerationInfo,
	type PluginGenerationInfo,
} from './plugins/runtime/PluginDefinitions'
export { requireConfigService } from './internal/config-service'
export { requirePluginService } from './internal/plugin-service'
export {
	requireFs,
	requireHostDocuments,
	requireTinyBaseHost,
	requireVaultHost,
} from './internal/storage'
export { observeFile } from './fs/observe'
export { pluginNodePhysicalKey } from './internal/plugin-address'
export {
	createContextHost,
	installOwnerViewService,
	installRootService,
	installScopeService,
	getServiceInstallationDefinition,
	type ServiceDefinition,
	type ServiceInstallation,
} from '@pluxel/context'
export {
	resolveContextService,
	getServiceDefinitionKey,
	getServiceDefinitionAccess,
	getInstalledServiceDefinitions,
	resolveInstalledServiceDefinition,
	getInstalledServiceAccess,
	createServiceRef,
	type ServiceKey,
} from '@pluxel/context/internal'
export {
	readServiceDefinition,
	createServiceReference,
	setServiceControlContract,
} from './services/definition'
export { createGenerationContext, createOwnerContext } from './context/context-factory'
export { getPluginGenerationContext } from './plugins/composition/BasePlugin'
export { isPluginPartContext } from './plugins/composition/PluginPart'
export { createCoreRootContext } from './context/core-plan'
export {
	checkPluginDecorator,
	consumePluginDefinitionCandidate,
	type ConcretePluginDefinitionCandidate,
	type ConcretePluginDefinitionDeclaration,
	type PluginConfigDefinition,
} from './plugins/runtime/definition'
export type {
	PartConfigDeclaration,
	PluginPartDefinitionNode,
	PluginPartDefinitionTree,
} from './plugins/runtime/part-definition'
export { CALLER_CONTEXT_BIND } from './plugins/composition/symbols'
export {
	WORKBENCH_CONTENT_ARTIFACT_FILE,
	WORKBENCH_CONTENT_ARTIFACT_ROOT,
	WORKBENCH_CONTENT_ARTIFACT_VERSION,
	WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE,
	createWorkbenchContentDeploymentInventory,
	createWorkbenchContentSet,
	parseWorkbenchContentDeploymentInventory,
	parseWorkbenchContentPlan,
	parseWorkbenchContentSet,
	serializeWorkbenchContentDefinition,
	serializeWorkbenchContentSet,
	workbenchContentArtifactRoot,
	type WorkbenchContentActionSlot,
	type WorkbenchContentBlock,
	type WorkbenchContentDataSlot,
	type WorkbenchContentDeploymentEntry,
	type WorkbenchContentDeploymentInventory,
	type WorkbenchContentDocumentPlan,
	type WorkbenchContentInline,
	type WorkbenchContentPlan,
	type WorkbenchContentSet,
	type WorkbenchContentSetEntry,
	type WorkbenchContentSlot,
	type WorkbenchContentTableAlignment,
	type WorkbenchContentTableCell,
	type WorkbenchContentTableRow,
} from './internal/workbench-content-artifact'
export { immutableConfigRecord } from './services/config/immutable'

export {
	assertStartTimeoutMs,
	createCorePluginExecutionBinding,
	DEFAULT_PLUGIN_EXECUTION,
} from './context/plugin-execution'
export { snapshotCoreFacilitiesConfig } from './context/core-facilities'

export { recordSecurityEvent, listSecurityEvents, type SecurityEvent } from './internal/security'

export { snapshotVaultBindings } from './vault/bindings'

export { snapshotVaultConfig } from './vault/options'

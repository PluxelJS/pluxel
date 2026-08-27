export {
	closeOwnerInvocations,
	enterOwnerInvocation,
	type OwnerInvocationLease,
} from './internal/owner-invocations'

export { PluginSlotRegistry } from './plugins/runtime/identity'
export { PluginService } from './plugins/runtime/PluginService'
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
	defineContextCapability,
	installOwnerViewCapability,
	installRootCapability,
	installScopeCapability,
	resolveContextCapability,
	type ContextCapability,
	type ContextCapabilityInstallation,
} from '@pluxel/context'
export { createGenerationContext, createOwnerContext } from './context/context-factory'
export { isPluginPartContext } from './plugins/composition/PluginPart'
export {
	CONFIG_SERVICE_CAPABILITY,
	createCoreContextInstallations,
	createCoreRootContext,
	resolveCoreRootInputs,
	EFFECTS_CAPABILITY,
	LOGGER_CAPABILITY,
	PLUGIN_SERVICE_CAPABILITY,
	type CoreRootInputs,
} from './context/core-plan'
export { checkPluginDecorator } from './plugins/decorators/decorator/api'
export {
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

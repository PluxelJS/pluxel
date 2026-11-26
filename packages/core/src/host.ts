/** Host and service composition. Resource acquisition belongs to Host preparation, not plan compilation. */
export {
	getServiceInstallationDefinition,
	type ServiceAccess,
	type ServiceDefinition,
	type ServiceRef,
	type ServiceClass,
	type ServiceInstallation,
	type RootServiceInstallation,
	type ScopeServiceInstallation,
	type OwnerViewServiceInstallation,
	type ContextHost,
	type ContextOf,
	type RootContextOf,
} from '@pluxel/context'
export { createCoreContextHost, snapshotCoreFacilitiesConfig } from './context/zenfs-plan'
export { prepareCoreContext } from './context/core-logging'
export type { Context, RootContext, CoreFacilitiesConfig, CoreHostConfig } from './context/Context'
export type { CoreExecutionConfig } from './context/plugin-execution'

export {
	installOwnerViewService,
	installRootService,
	installScopeService,
} from './services/installation'
export { clearOutboundHttpNode, requireOutboundHttp } from './http/host'

export type {
	ManagedOutboundHttpSnapshot,
	OutboundHttpActivity,
	OutboundHttpEffectiveSettings,
	OutboundHttpLimits,
	OutboundHttpOptions,
	OutboundHttpRecords,
	OutboundHttpSaveResult,
	OutboundHttpSettings,
	OutboundHttpSnapshot,
} from './http/types'

export { enterOwnerInvocation, type OwnerInvocationLease } from './internal/owner-invocations'
export type {
	CorePluginLifecycleHooks,
	CoreGenerationFinalization,
	CoreGenerationSettlement,
	CoreGenerationRejection,
	CoreCommitPublication,
} from './plugins/runtime/plugin-service/HostLifecycle'
export { getContextLoggerRootId } from './logger/LoggerService'

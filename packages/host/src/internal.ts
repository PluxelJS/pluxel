export * from './catalog'
export * from './coordinator'
export * from './mutation'
export * from './reconcile'
export * from './state'
export * from './policy'
export * from './install'
export * from './driver'
export { installPluginSources, pluginSourceCovers, pluginSourceKey } from './source-contract'
export { discoverPluginSources, resolvePluginSourcePath } from './source-discovery'
export { collectPluginModuleExports } from './module'

export { planHostServices, prepareHostServices, createHostServiceLifecycle } from './services'
export {
	lookupPluginConfig,
	pluginConfigGet,
	pluginConfigValidate,
	pluginConfigPatch,
	pluginConfigReset,
	readHostConfigState,
} from './config'
export { HostConfigStore, type PluginConfigFile } from './config-store'
export {
	HostStateStore,
	HostPolicyRevisionConflictError,
	HostPolicyMutationRejectedError,
	canonicalHostStateSnapshot,
	type HostStateFile,
} from './state-store'
export type { HostStateConfigurationSnapshot } from './state-store'
export { createHostPolicy } from './policy-management'
export { coercePluginConfigRecords, mergeConfigRecords } from './config-records'

export * from './state-helpers'
export * from './diagnostics'
export * from './status'

export { ensureFork, removeFork, type ForkEnsureResult, type ForkRemoveResult } from './forks'

export { requireHostStateStore } from './host'

export * from './recent-update'

export { projectPluginApplyReport } from './apply-report'

export { setHostCatalogProvenance } from './catalog-provenance'

export { updateHostCatalog } from './host'

export {
	hostSharedPackages,
	resolveNativeImport,
	installedPackageFacts,
	assertSharedPackageVersion,
	importPackageName,
} from './shared-packages'
export {
	readLoadedPluginModule,
	recordLoadedPluginModule,
	recordLoadedHostApplication,
	readLoadedHostApplicationModule,
} from './loaded-modules'

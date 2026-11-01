/** Browser and Web Worker composition, without Node application loading or source discovery. */
export { createHost, type HostOptions, type PluginHost } from './host'
export { defineHostService, type HostService, type HostServiceDependencies } from './services'
export type { PluginApplyReport } from './coordinator'
export type { HostPluginStatusOverview, HostPluginStatusSnapshot } from './status'
export type { HostConfigState, HostPluginConfigResult } from './config'
export type {
	HostConfigArtifact,
	HostConfigVersion,
	HostConfigMutationOptions,
	HostConfigSyncOptions,
	HostConfigSyncStatus,
	HostConfigSync,
} from './config-sync-protocol'

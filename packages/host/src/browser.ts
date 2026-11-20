import type { CoreFacilitiesConfig } from '@pluxel/core'
import { snapshotZenFsCoreFacilitiesConfig } from '@pluxel/core/internal/zenfs'
import {
	createHostFromOptions,
	type HostOptions as EmbeddedHostOptions,
	type PluginHost,
} from './host'

export type HostOptions = Omit<EmbeddedHostOptions, 'coreConfig'> &
	Readonly<{
		coreConfig?: Omit<CoreFacilitiesConfig, 'http'> &
			Readonly<{
				http?: CoreFacilitiesConfig['http'] &
					Readonly<{ proxyUrl?: null; allowProxyChanges?: false }>
			}>
	}>

/** Prepare a browser or Web Worker Host with ZenFS and the browser Fetch transport. */
export function createHost(options: HostOptions): Promise<PluginHost> {
	return createHostFromOptions(options, snapshotZenFsCoreFacilitiesConfig)
}

export type { PluginHost } from './host'
export { defineHostService, type HostService, type HostServiceDependencies } from './services'
export type { PluginApplyReport } from './coordinator'
export type { HostPluginStatusOverview, HostPluginStatusSnapshot } from './status'
export type { HostConfigState, HostPluginConfigResult } from './config'
export type { HostConfigMutation, HostConfigInputSnapshot, HostPluginConfig } from './config'
export type { HostConfigOptions, ConfigInputPatch } from './config-records'
export type { HostPolicyOptions, HostPolicyInput, HostPolicyValues } from './policy'
export type { HostPolicy, HostPolicyResult } from './policy-management'
export type { HostInputMode } from './input-mode'
export type { HostPersistenceResult, HostPersistenceRetention } from './persistence'
export type { HostDocumentStorage, HostDocumentOptions } from './document-storage'

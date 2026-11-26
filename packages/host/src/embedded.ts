import type { PortableApplication } from './application'
import { startEmbeddedApplication, type HostInputs } from './embedded-application'
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

/** Prepare an application-owned Host with ZenFS and the host environment’s Fetch transport. */
export function createHost(options: HostOptions): Promise<PluginHost> {
	return createHostFromOptions(options, snapshotZenFsCoreFacilitiesConfig)
}

/** Start and accept an isolated root from reusable declarations. The caller owns its lifetime. */
export function startHost(
	application: PortableApplication<HostOptions['coreConfig']>,
	input?: HostInputs,
): Promise<PluginHost> {
	return startEmbeddedApplication(application, snapshotZenFsCoreFacilitiesConfig, input)
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

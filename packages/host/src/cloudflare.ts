import type { CoreFacilitiesConfig } from '@pluxel/core'
import { snapshotRequestCoreFacilitiesConfig } from '@pluxel/core/internal'
import { createHostFromOptions, type HostOptions, type PluginHost } from './host'

export type { PluginHost } from './host'
export { defineHostService, type HostService, type HostServiceDependencies } from './services'

export type CloudflareHostOptions = Omit<HostOptions, 'coreConfig'> &
	Readonly<{
		coreConfig?: Omit<CoreFacilitiesConfig, 'zenfs' | 'logtape' | 'vault' | 'http'> &
			Readonly<{
				zenfs?: never
				logtape?: never
				vault?: Readonly<{ backend?: 'bindings'; deployIdentity?: never }>
				http?: CoreFacilitiesConfig['http'] &
					Readonly<{ proxyUrl?: never; allowProxyChanges?: never }>
			}>
	}>

/**
 * Prepare a Host inside the current Cloudflare Workers request.
 * The caller starts and closes the Host within the request's lifetime.
 */
export function createHost(options: CloudflareHostOptions): Promise<PluginHost> {
	return createHostFromOptions(options, snapshotRequestCoreFacilitiesConfig)
}

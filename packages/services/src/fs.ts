/// <reference types="node" preserve="true" />
import { installOwnerViewCapability, installRootCapability } from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host/browser'
import { pluginNodePhysicalKey } from './internal/plugin-address'
import { FsService, snapshotFsConfig, type FsServiceConfig } from './fs/service'
import { Fs, PluginFs } from './fs/token'

export { Fs, PluginFs } from './fs/token'
export { writeFileAtomic } from './fs/atomic'
export type { FsService, FsServiceConfig, FsPromises, FsRequirement } from './fs/service'
export { InMemory, Passthrough } from '@zenfs/core'

/** Declare one filesystem per Host. Resource acquisition starts at first async IO or service prepare. */
export function fs(options: FsServiceConfig) {
	const config = snapshotFsConfig(options)
	return defineHostService({
		name: 'Fs',
		capabilities: [
			installRootCapability(Fs, { create: (root) => new FsService(root, config) }),
			installOwnerViewCapability(PluginFs, {
				property: 'fs',
				createRoot: (root) => root.require(Fs),
				createView: (service, owner) => {
					const address = owner.pluginInfo?.nodeAddress
					if (!address) throw new TypeError('[services.fs] PluginFs requires a Plugin node address')
					const directory = `plugins/${pluginNodePhysicalKey(address)}`
					return (requirement) => service.directory(directory, requirement)
				},
			}),
		],
		async prepare({ ctx }) {
			await ctx.require(Fs).ready()
		},
	})
}

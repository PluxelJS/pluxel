import { defineContextCapability } from '@pluxel/core/host'
import type { FsPromises, FsRequirement, FsService } from './service'

/** Host-owned filesystem preparation and fixed service directories. */
export const Fs = defineContextCapability<FsService>('services.fs', { access: 'root' })

/** Obtain the owning Plugin node's persistent directory, including its fork identity. */
export const PluginFs = defineContextCapability<
	(requirement?: FsRequirement) => Promise<FsPromises>
>('services.plugin-fs', { access: 'owner', property: 'fs' })

declare module '@pluxel/core' {
	interface ContextServices {
		readonly fs: (requirement?: FsRequirement) => Promise<FsPromises>
	}
}

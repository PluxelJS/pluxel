/// <reference types="node" preserve="true" />
/** Runtime data backends and native file contracts; Plugin data access is always available through ctx.fs(). */
export { InMemory, Passthrough } from '@zenfs/core'
export type {
	Backend,
	BackendConfiguration,
	Configuration,
	ConfigMounts,
	MountConfiguration,
	FileSystem,
	BoundContext,
} from '@zenfs/core'
export { writeFileAtomic } from './fs/atomic'
export type { FsConfig, FsPromises, FsRequirement } from './fs/service'

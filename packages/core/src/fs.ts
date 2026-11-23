/// <reference types="node" preserve="true" />
/** ZenFS backends and file contracts for Hosts that provide Plugin directories. */
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

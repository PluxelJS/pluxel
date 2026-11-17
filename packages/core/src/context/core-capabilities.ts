import type { ConfigService } from '../services/config/ConfigService'
import type { PluginService } from '../plugins/runtime/PluginService'
import type { FsPromises, FsRequirement } from '../fs/service'

/** A Plugin generation's filesystem directory capability. */
export abstract class Fs {
	static readonly access = 'owner' as const
}
export interface Fs {
	(requirement?: FsRequirement): Promise<FsPromises>
}

/** Framework-owned configuration authority. */
export abstract class PluginConfigService {
	static readonly access = 'root' as const
}
export interface PluginConfigService extends ConfigService {}

/** A leaf declaration keeps graph implementation imports out of Context assembly. */
export abstract class PluginRuntimeService {
	static readonly access = 'root' as const
}
export interface PluginRuntimeService extends PluginService {}

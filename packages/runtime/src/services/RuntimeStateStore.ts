import type { PluginNodeAddress } from '@pluxel/core'
import type { HostStateSnapshot as RuntimeStateSnapshot } from '@pluxel/host'
export {
	type HostStateSnapshot as RuntimeStateSnapshot,
	type HostStateVersionedSnapshot as RuntimeStateVersionedSnapshot,
	HostStateRevisionConflictError as RuntimeStateRevisionConflictError,
	type HostStateDraft as RuntimeStateDraft,
	type HostForkState as RuntimeForkState,
	type HostProviderDefaultState as RuntimeProviderDefaultState,
	type HostDependencyOverrideState as RuntimeDependencyOverrideState,
	freezeTrustedHostStateSnapshot as freezeTrustedRuntimeStateSnapshot,
} from '@pluxel/host/internal'

export type RuntimeStateStoreMode = 'file' | 'memory' | 'readonly'

export interface RuntimeStateStoreConfig {
	mode?: RuntimeStateStoreMode
	snapshot?: Omit<Partial<RuntimeStateSnapshot>, 'autoStart'> & {
		autoStart?: Iterable<PluginNodeAddress>
	}
}

export {
	HostStateStore as RuntimeStateStore,
	canonicalHostStateSnapshot as canonicalRuntimeStateSnapshot,
} from '@pluxel/host/internal'
export type { HostStateFile as RuntimeStateFile } from '@pluxel/host/internal'
export {
	isPluginAutoStartEnabled,
	listForkIds,
	replaceAutoStartPlugins,
	setPluginAutoStart,
	setPluginsAutoStart,
} from './RuntimeStateHelpers'

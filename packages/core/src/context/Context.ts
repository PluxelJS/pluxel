import type { FsConfig } from '../fs/service'
import type { TinyBaseOptions } from '../tinybase/types'
import type { Context as BaseContext, RootContext as BaseRootContext } from '@pluxel/context'
import type { LogTapeConfig } from '../config/logtape'
import type { PluginNodeInfo } from '../plugins/runtime/PluginDefinitions'
import type { PluginServiceConfig } from '../plugins/runtime/PluginService'
import type { EventsServiceConfig } from '../services/events/EventsService'

/** Plugin-facing Context. Service installation and construction remain Host-owned. */
export interface Context extends BaseContext<RootContext> {
	readonly pluginInfo?: PluginNodeInfo
	readonly caller?: Context
}

/** Host root with root and shared service access. */
export interface RootContext extends Context, BaseRootContext<RootContext> {}

/** Context owned by one running Plugin generation and shared by its Parts. */
export interface PluginContext extends Context {
	readonly pluginInfo: PluginNodeInfo
}

/** Public configuration shared by Core-based host constructors. */
export interface CoreHostConfig {
	name?: string
	/** Native LogTape configuration or root factory, optionally with framework policy options. */
	logtape?: LogTapeConfig
	events?: EventsServiceConfig
	plugins?: PluginServiceConfig
	/** Native ZenFS mounts shared by Plugin files and state. Omitted means an isolated InMemory root. */
	zenfs?: FsConfig
	/** Snapshot policy; the backend is selected once through zenfs. */
	tinybase?: TinyBaseOptions
}

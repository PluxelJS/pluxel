import type { Context as BaseContext, RootContext as BaseRootContext } from '@pluxel/context'
import type { ContextLogger } from '../logger/LoggerService'
import type { LogTapeConfig } from '../config/logtape'
import type { RuntimeLogging } from '../logging/logging'
import type { PluginNodeInfo } from '../plugins/runtime/PluginDefinitions'
import type { PluginServiceConfig } from '../plugins/runtime/PluginService'
import type { EffectsScope } from '../services/effects/EffectsService'
import type { EventsService, EventsServiceConfig } from '../services/events/EventsService'
import type { FsConfig, FsPromises, FsRequirement } from '../fs/service'
import type { TinyBaseOptions, TinyBaseService } from '../tinybase/types'

/** Known owner-facing service vocabulary. Entries remain optional until a host proves installation. */
export interface ContextServices {}

/** Known root service vocabulary, never projected onto Plugin and Part Contexts. */
export interface RootContextServices {}

/** Plugin-facing owner and capability projection. Construction remains host-owned. */
export interface Context extends BaseContext<RootContext>, Readonly<Partial<ContextServices>> {
	readonly logger: ContextLogger
	readonly effects: EffectsScope
	readonly events: EventsService
	readonly pluginInfo?: PluginNodeInfo
	readonly caller?: Context
}

/** Host root with Core and host-owned root capabilities. */
export interface RootContext
	extends Context, BaseRootContext<RootContext>, Readonly<Partial<RootContextServices>> {
	/** The single Core logging runtime, present only when config.logger is declared. */
	readonly logging?: RuntimeLogging
}

/** Context owned by one running Plugin generation and shared by its Parts. */
export interface PluginContext extends Context {
	readonly pluginInfo: PluginNodeInfo
	/** Borrow the owning Plugin node's runtime data directory. */
	readonly fs: (requirement?: FsRequirement) => Promise<FsPromises>
	/** The owning Plugin generation's single native Store bridge. */
	readonly tinybase: TinyBaseService
}

/** Public configuration shared by Core-based host constructors. */
export interface CoreHostConfig {
	name?: string
	/** Native LogTape configuration declared with logtape() from @pluxel/core/config. */
	logger?: LogTapeConfig
	events?: EventsServiceConfig
	plugins?: PluginServiceConfig
	/** Native ZenFS mounts shared by Plugin files and state. Omitted means an isolated InMemory root. */
	storage?: FsConfig
	/** Snapshot policy; the backend is selected once through storage. */
	tinybase?: TinyBaseOptions
}

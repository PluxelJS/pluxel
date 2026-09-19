import type { Context as BaseContext, RootContext as BaseRootContext } from '@pluxel/context'
import type { LoggerServiceConfig, ContextLogger } from '../logger/LoggerService'
import type { PluginNodeInfo } from '../plugins/runtime/PluginDefinitions'
import type { PluginServiceConfig } from '../plugins/runtime/PluginService'
import type { EffectsScope } from '../services/effects/EffectsService'
import type { EventsService, EventsServiceConfig } from '../services/events/EventsService'

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
	extends Context, BaseRootContext<RootContext>, Readonly<Partial<RootContextServices>> {}

/** Context owned by one running Plugin generation and shared by its Parts. */
export interface PluginContext extends Context {
	readonly pluginInfo: PluginNodeInfo
}

/** Public configuration shared by Core-based host constructors. */
export interface CoreHostConfig {
	name?: string
	logger?: LoggerServiceConfig
	events?: EventsServiceConfig
	plugins?: PluginServiceConfig
}

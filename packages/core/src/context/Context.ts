import type { Context as BaseContext, RootContext as BaseRootContext } from '@pluxel/context'
import type { LoggerServiceConfig, ContextLogger } from '../logger/LoggerService'
import type { PluginNodeInfo } from '../plugins/runtime/PluginDefinitions'
import type { PluginServiceConfig } from '../plugins/runtime/PluginService'
import type { EffectsScope } from '../services/effects/EffectsService'

/** Plugin-facing owner and capability projection. Construction remains host-owned. */
export interface Context extends BaseContext<RootContext> {
	readonly logger: ContextLogger
	readonly effects: EffectsScope
	readonly pluginInfo?: PluginNodeInfo
	readonly caller?: Context
}

/** Host root with Core and host-owned root capabilities. */
export interface RootContext extends Context, BaseRootContext<RootContext> {}

/** Context owned by one running Plugin generation and shared by its Parts. */
export interface PluginContext extends Context {
	readonly pluginInfo: PluginNodeInfo
}

/** Public configuration shared by Core-based host constructors. */
export interface CoreHostConfig {
	name?: string
	logger?: LoggerServiceConfig
	plugins?: PluginServiceConfig
}

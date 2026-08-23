import type { ContextLogger } from '../logger/LoggerService'
import type { ConfigService } from '../services/config/ConfigService'
import type { EffectsScope } from '../services/effects/EffectsService'
import { defineContextCapability, type ContextCapability } from './Context'

export const LOGGER_CAPABILITY: ContextCapability<ContextLogger> =
	defineContextCapability('core.logger')
export const EFFECTS_CAPABILITY: ContextCapability<EffectsScope> =
	defineContextCapability('core.effects')
export const CONFIG_SERVICE_CAPABILITY: ContextCapability<ConfigService> =
	defineContextCapability('core.plugin-config')

// PluginService is intentionally represented only by its object identity here. Importing the
// high-level graph coordinator into the low-level capability module would invert the dependency
// direction and recreate the composition/runtime cycle this descriptor is meant to break.
export const PLUGIN_SERVICE_CAPABILITY_IDENTITY: ContextCapability<object> =
	defineContextCapability('core.plugin-runtime')

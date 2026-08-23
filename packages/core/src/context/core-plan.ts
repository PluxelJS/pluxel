import { ConfigService } from '../services/config/ConfigService'
import { EffectsService } from '../services/effects/EffectsService'
import { LoggerService, type LoggerServiceConfig } from '../logger/LoggerService'
import { PluginService, type PluginServiceConfig } from '../plugins/runtime/PluginService'
import {
	createContextHost,
	installRootCapability,
	installScopeCapability,
	type ContextCapability,
	type ContextCapabilityInstallation,
} from '@pluxel/context'
import { type CoreHostConfig, type Context, type RootContext } from './Context'
import {
	CONFIG_SERVICE_CAPABILITY,
	EFFECTS_CAPABILITY,
	LOGGER_CAPABILITY,
	PLUGIN_SERVICE_CAPABILITY_IDENTITY,
} from './core-capabilities'

export const PLUGIN_SERVICE_CAPABILITY =
	PLUGIN_SERVICE_CAPABILITY_IDENTITY as ContextCapability<PluginService>

export { CONFIG_SERVICE_CAPABILITY, EFFECTS_CAPABILITY, LOGGER_CAPABILITY }

export type CoreRootInputs = Readonly<{
	name: string
	logger?: Readonly<LoggerServiceConfig>
	plugins?: Readonly<PluginServiceConfig>
}>

export function resolveCoreRootInputs(config: CoreHostConfig = {}): CoreRootInputs {
	return Object.freeze({
		name: config.name ?? 'root',
		...(config.logger ? { logger: Object.freeze({ ...config.logger }) } : {}),
		...(config.plugins ? { plugins: Object.freeze({ ...config.plugins }) } : {}),
	})
}

export function createCoreContextInstallations(
	inputs: CoreRootInputs,
): readonly ContextCapabilityInstallation[] {
	return Object.freeze([
		installScopeCapability(LOGGER_CAPABILITY, {
			property: 'logger',
			create: (ctx) => new LoggerService(ctx as Context, inputs.logger),
		}),
		installScopeCapability(EFFECTS_CAPABILITY, {
			property: 'effects',
			create: (ctx) => new EffectsService(ctx as Context, undefined),
		}),
		installRootCapability(CONFIG_SERVICE_CAPABILITY, {
			create: (ctx) => new ConfigService(ctx as RootContext),
		}),
		installRootCapability(PLUGIN_SERVICE_CAPABILITY, {
			create: (ctx) => new PluginService(ctx as RootContext, inputs.plugins),
		}),
	])
}

export function createCoreRootContext(config: CoreHostConfig = {}): RootContext {
	const inputs = resolveCoreRootInputs(config)
	const host = createContextHost({
		name: 'core',
		capabilities: createCoreContextInstallations(inputs),
	})
	return host.createRoot(inputs.name) as RootContext
}

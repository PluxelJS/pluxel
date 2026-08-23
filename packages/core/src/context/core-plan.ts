import { ConfigService } from '../services/config/ConfigService'
import { EffectsService } from '../services/effects/EffectsService'
import { LoggerService, type LoggerServiceConfig } from '../logger/LoggerService'
import { PluginService, type PluginServiceConfig } from '../plugins/runtime/PluginService'
import {
	createContextPlan,
	createRootContext,
	installGenerationCapability,
	installRootCapability,
	type CoreHostConfig,
	type ContextCapability,
	type ContextCapabilityInstallation,
	type ContextPlan,
	type RootContext,
} from './Context'
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
		installGenerationCapability(LOGGER_CAPABILITY, {
			property: 'logger',
			create: (ctx) => new LoggerService(ctx, inputs.logger),
		}),
		installGenerationCapability(EFFECTS_CAPABILITY, {
			property: 'effects',
			create: (ctx) => new EffectsService(ctx, undefined),
		}),
		installRootCapability(CONFIG_SERVICE_CAPABILITY, {
			create: (ctx) => new ConfigService(ctx),
		}),
		installRootCapability(PLUGIN_SERVICE_CAPABILITY, {
			create: (ctx) => new PluginService(ctx, inputs.plugins),
		}),
	])
}

export function createCoreRootContext(config: CoreHostConfig = {}): RootContext {
	const inputs = resolveCoreRootInputs(config)
	const plan: ContextPlan = createContextPlan('core', createCoreContextInstallations(inputs))
	return createRootContext(plan, inputs.name)
}

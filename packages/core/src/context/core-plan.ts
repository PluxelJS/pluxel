import { ConfigService } from '../services/config/ConfigService'
import { EffectsService } from '../services/effects/EffectsService'
import { createEventsBackend, createEventsServiceView } from '../services/events/EventsService'
import { LoggerService, type LoggerServiceConfig } from '../logger/LoggerService'
import { PluginService, type PluginServiceConfig } from '../plugins/runtime/PluginService'
import {
	freezeCorePluginLifecycleHooks,
	type CorePluginLifecycleHooks,
} from '../plugins/runtime/plugin-service/HostLifecycle'
import {
	createContextHost,
	installRootCapability,
	installOwnerViewCapability,
	installScopeCapability,
	type ContextCapability,
	type ContextCapabilityInstallation,
} from '@pluxel/context'
import { type CoreHostConfig, type Context, type RootContext } from './Context'
import {
	CONFIG_SERVICE_CAPABILITY,
	EFFECTS_CAPABILITY,
	EVENTS_CAPABILITY,
	LOGGER_CAPABILITY,
	PLUGIN_SERVICE_CAPABILITY_IDENTITY,
} from './core-capabilities'

export const PLUGIN_SERVICE_CAPABILITY =
	PLUGIN_SERVICE_CAPABILITY_IDENTITY as ContextCapability<PluginService>

export { CONFIG_SERVICE_CAPABILITY, EFFECTS_CAPABILITY, EVENTS_CAPABILITY, LOGGER_CAPABILITY }

export type CoreRootInputs = Readonly<{
	name: string
	logger?: Readonly<LoggerServiceConfig>
	events?: Readonly<import('../services/events/EventsService').EventsServiceConfig>
	plugins?: Readonly<PluginServiceConfig>
}>

export function resolveCoreRootInputs(config: CoreHostConfig = {}): CoreRootInputs {
	return Object.freeze({
		name: config.name ?? 'root',
		...(config.logger ? { logger: Object.freeze({ ...config.logger }) } : {}),
		...(config.events
			? {
					events: Object.freeze({
						...config.events,
						...(config.events.events ? { events: Object.freeze([...config.events.events]) } : {}),
					}),
				}
			: {}),
		...(config.plugins ? { plugins: Object.freeze({ ...config.plugins }) } : {}),
	})
}

export function createCoreContextInstallations(
	inputs: CoreRootInputs,
	lifecycleHooks: CorePluginLifecycleHooks | ((root: RootContext) => CorePluginLifecycleHooks) = {},
	createConfigService: (root: RootContext) => ConfigService = (root) => new ConfigService(root),
): readonly ContextCapabilityInstallation[] {
	const fixedLifecycleHooks =
		typeof lifecycleHooks === 'function'
			? lifecycleHooks
			: freezeCorePluginLifecycleHooks(lifecycleHooks)
	return Object.freeze([
		installScopeCapability(LOGGER_CAPABILITY, {
			property: 'logger',
			create: (ctx) => new LoggerService(ctx as Context, inputs.logger),
		}),
		installScopeCapability(EFFECTS_CAPABILITY, {
			property: 'effects',
			create: (ctx) => new EffectsService(ctx as Context, undefined),
		}),
		installOwnerViewCapability(EVENTS_CAPABILITY, {
			property: 'events',
			createRoot: (root) => createEventsBackend(root as RootContext, inputs.events),
			createView: (backend, owner) => createEventsServiceView(backend, owner as Context),
		}),
		installRootCapability(CONFIG_SERVICE_CAPABILITY, {
			create: (ctx) => createConfigService(ctx as RootContext),
		}),
		installRootCapability(PLUGIN_SERVICE_CAPABILITY, {
			create: (ctx) =>
				new PluginService(
					ctx as RootContext,
					inputs.plugins,
					typeof fixedLifecycleHooks === 'function'
						? freezeCorePluginLifecycleHooks(fixedLifecycleHooks(ctx as RootContext))
						: fixedLifecycleHooks,
				),
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

/** Compile a Core host with an explicit, immutable set of additional capabilities. */
export function createCoreContextHost<
	const TCapabilities extends readonly ContextCapabilityInstallation[] = readonly [],
>(
	config: CoreHostConfig & {
		/** Overrides only the fixed Core config service. The factory is lazy; resources belong to root effects. */
		readonly createConfigService?: (root: RootContext) => ConfigService
		/** Fixed host publication stages; evaluated once when the root Plugin service is constructed. */
		readonly createLifecycleHooks?: (root: RootContext) => CorePluginLifecycleHooks
		readonly capabilities?: TCapabilities &
			import('@pluxel/context').ValidateContextInstallations<
				TCapabilities,
				| Exclude<keyof Context, keyof import('./Context').ContextServices>
				| 'constructor'
				| '__proto__'
			>
	} = {},
) {
	if (
		config.createConfigService !== undefined &&
		typeof config.createConfigService !== 'function'
	) {
		throw new TypeError('[pluxel/core] createConfigService must be a function')
	}
	const inputs = resolveCoreRootInputs(config)
	return createContextHost({
		name: inputs.name,
		reservedProperties: ['pluginInfo', 'caller'],
		capabilities: [
			...createCoreContextInstallations(
				inputs,
				config.createLifecycleHooks,
				config.createConfigService,
			),
			...(config.capabilities ?? []),
		],
	}) as import('@pluxel/context').ContextHost<
		Context &
			import('@pluxel/context').ContextProjection<TCapabilities> & {
				readonly root: RootContext & import('@pluxel/context').RootContextProjection<TCapabilities>
			},
		RootContext & import('@pluxel/context').RootContextProjection<TCapabilities>
	>
}

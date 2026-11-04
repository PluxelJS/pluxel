import {
	createCorePluginExecutionBinding,
	assertCorePluginExecutionBinding,
	type CorePluginExecutionBinding,
} from './plugin-execution'
import { ConfigService } from '../services/config/ConfigService'
import { EffectsService } from '../services/effects/EffectsService'
import { createEventsBackend, createEventsServiceView } from '../services/events/EventsService'
import { LoggerService } from '../logger/LoggerService'
import { resolveLogTapeConfig, type ResolvedLogTapeConfig } from '../config/logtape'
import { Logging } from '../logging/service'
import { createCoreLoggingRuntime } from './core-logging'
import { PluginService, type PluginServiceConfig } from '../plugins/runtime/PluginService'
import { FsService, snapshotFsConfig } from '../fs/service'
import { TinyBaseRuntime } from '../tinybase/service'
import { resolveTinyBaseOptions } from '../tinybase/options'
import type { TinyBaseOptions } from '../tinybase/types'
import { pluginNodePhysicalKey } from '../internal/plugin-address'
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
	FS_CAPABILITY,
	PLUGIN_FS_CAPABILITY,
	TINYBASE_HOST_CAPABILITY,
	TINYBASE_CAPABILITY,
} from './core-capabilities'

export const PLUGIN_SERVICE_CAPABILITY =
	PLUGIN_SERVICE_CAPABILITY_IDENTITY as ContextCapability<PluginService>

export { CONFIG_SERVICE_CAPABILITY, EFFECTS_CAPABILITY, EVENTS_CAPABILITY, LOGGER_CAPABILITY }

export type CoreRootInputs = Readonly<{
	name: string
	logtape?: ResolvedLogTapeConfig
	events?: Readonly<import('../services/events/EventsService').EventsServiceConfig>
	plugins?: Readonly<PluginServiceConfig>
	zenfs: ReturnType<typeof snapshotFsConfig>
	tinybase: Required<TinyBaseOptions>
}>

export function resolveCoreRootInputs(config: CoreHostConfig = {}): CoreRootInputs {
	return Object.freeze({
		name: config.name ?? 'root',
		zenfs: snapshotFsConfig(config.zenfs === undefined ? {} : config.zenfs),
		tinybase: resolveTinyBaseOptions(config.tinybase),
		logtape: resolveLogTapeConfig(config.logtape),
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
	executionBinding?: CorePluginExecutionBinding,
): readonly ContextCapabilityInstallation[] {
	const execution = executionBinding ?? createCorePluginExecutionBinding()
	assertCorePluginExecutionBinding(execution)
	if (!executionBinding) execution.bind(inputs.plugins ?? {})
	const fixedLifecycleHooks =
		typeof lifecycleHooks === 'function'
			? lifecycleHooks
			: freezeCorePluginLifecycleHooks(lifecycleHooks)
	return Object.freeze([
		installScopeCapability(LOGGER_CAPABILITY, {
			property: 'logger',
			create: (ctx) => new LoggerService(ctx as Context),
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
		installRootCapability(FS_CAPABILITY, {
			create: (root) => new FsService(root as RootContext, inputs.zenfs),
		}),
		installOwnerViewCapability(PLUGIN_FS_CAPABILITY, {
			property: 'fs',
			createRoot: (root) => root.require(FS_CAPABILITY),
			createView: (filesystem, owner) => {
				const address = (owner as Context).pluginInfo?.nodeAddress
				if (!address) throw new TypeError('[core.fs] A Plugin node address is required')
				const directory = `plugins/${pluginNodePhysicalKey(address)}`
				return (requirement) => filesystem.directory(directory, requirement)
			},
		}),
		installRootCapability(TINYBASE_HOST_CAPABILITY, {
			create: (root) =>
				new TinyBaseRuntime(
					root as RootContext,
					root.require(FS_CAPABILITY),
					inputs.tinybase.maxSnapshotBytes,
				),
		}),
		...(inputs.logtape
			? [
					installRootCapability(Logging, {
						property: 'logging',
						create: (root) => createCoreLoggingRuntime(root as RootContext, inputs.logtape!),
					}),
				]
			: []),
		installScopeCapability(TINYBASE_CAPABILITY, {
			property: 'tinybase',
			create: (owner) => owner.root.require(TINYBASE_HOST_CAPABILITY).forOwner(owner as Context),
		}),
		installRootCapability(PLUGIN_SERVICE_CAPABILITY, {
			create: (ctx) => {
				const executionConfig = execution.read()
				const builtin = ctx.require(TINYBASE_HOST_CAPABILITY).lifecycle
				const hooks =
					typeof fixedLifecycleHooks === 'function'
						? freezeCorePluginLifecycleHooks(fixedLifecycleHooks(ctx as RootContext))
						: fixedLifecycleHooks
				return new PluginService(ctx as RootContext, executionConfig, {
					...hooks,
					async prepareCommit(publication) {
						await builtin.prepareCommit?.(publication)
						await hooks.prepareCommit?.(publication)
					},
					publishCommit(publication) {
						builtin.publishCommit?.(publication)
						return hooks.publishCommit?.(publication)
					},
				})
			},
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
		/** @internal One-time Host preparation seam; not a mutable runtime setting. */
		readonly executionBinding?: CorePluginExecutionBinding
		/** Overrides only the fixed Core config service. The factory is lazy; resources belong to root effects. */
		readonly createConfigService?: (root: RootContext) => ConfigService
		/** Fixed host publication stages; evaluated once when the root Plugin service is constructed. */
		readonly createLifecycleHooks?: (root: RootContext) => CorePluginLifecycleHooks
		readonly capabilities?: TCapabilities &
			import('@pluxel/context').ValidateContextInstallations<
				TCapabilities,
				| Exclude<
						keyof import('./Context').PluginContext,
						keyof import('./Context').ContextServices
				  >
				| 'constructor'
				| '__proto__'
				| 'logging'
			>
	} = {},
) {
	if (
		config.createConfigService !== undefined &&
		typeof config.createConfigService !== 'function'
	) {
		throw new TypeError('[pluxel/core] createConfigService must be a function')
	}
	if (config.executionBinding && config.plugins !== undefined)
		throw new TypeError('[core] executionBinding and plugins cannot be supplied together')
	const inputs = resolveCoreRootInputs(config)
	return createContextHost({
		name: inputs.name,
		reservedProperties: ['pluginInfo', 'caller', ...(!inputs.logtape ? ['logging'] : [])],
		capabilities: [
			...createCoreContextInstallations(
				inputs,
				config.createLifecycleHooks,
				config.createConfigService,
				config.executionBinding,
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

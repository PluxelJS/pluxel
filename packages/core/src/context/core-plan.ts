import {
	createCorePluginExecutionBinding,
	assertCorePluginExecutionBinding,
	type CorePluginExecutionBinding,
} from './plugin-execution'
import { ConfigService } from '../services/config/ConfigService'
import { EffectsService } from '../services/effects/EffectsService'
import {
	createEventsBackend,
	createEventsServiceView,
	EventsService,
} from '../services/events/EventsService'
import { LoggerService } from '../logger/LoggerService'
import { resolveLogTapeConfig, type ResolvedLogTapeConfig } from '../config/logtape'
import { Logging } from '../logging/service'
import { createCoreLoggingRuntime } from './core-logging'
import { PluginService, type PluginServiceConfig } from '../plugins/runtime/PluginService'
import { FsService, snapshotFsConfig } from '../fs/service'
import { TinyBaseRuntime } from '../tinybase/service'
import { resolveTinyBaseOptions } from '../tinybase/options'
import { type TinyBaseOptions, TinyBaseService, TinyBaseHostService } from '../tinybase/types'
import { pluginNodePhysicalKey } from '../internal/plugin-address'
import {
	freezeCorePluginLifecycleHooks,
	type CorePluginLifecycleHooks,
} from '../plugins/runtime/plugin-service/HostLifecycle'
import {
	createContextHost,
	installRootService,
	installOwnerViewService,
	installScopeService,
	type ServiceInstallation,
} from '@pluxel/context'
import { type CoreHostConfig, type Context, type RootContext } from './Context'
import { PluginConfigService, PluginRuntimeService, Fs } from './core-capabilities'

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
): readonly ServiceInstallation[] {
	const execution = executionBinding ?? createCorePluginExecutionBinding()
	assertCorePluginExecutionBinding(execution)
	if (!executionBinding) execution.bind(inputs.plugins ?? {})
	const fixedLifecycleHooks =
		typeof lifecycleHooks === 'function'
			? lifecycleHooks
			: freezeCorePluginLifecycleHooks(lifecycleHooks)
	return Object.freeze([
		installScopeService(LoggerService, {
			create: (ctx) => new LoggerService(ctx as Context),
		}),
		installScopeService(EffectsService, {
			create: (ctx) => new EffectsService(ctx as Context, undefined),
		}),
		installOwnerViewService(EventsService, {
			createRoot: (root) => createEventsBackend(root as RootContext, inputs.events),
			createView: (backend, owner) => createEventsServiceView(backend, owner as Context),
		}),
		installRootService(PluginConfigService, {
			create: (ctx) => createConfigService(ctx as RootContext),
		}),
		installRootService(FsService, {
			create: (root) => new FsService(root as RootContext, inputs.zenfs),
		}),
		installOwnerViewService(Fs, {
			createRoot: (root) => root.service(FsService),
			createView: (filesystem, owner) => {
				const address = (owner as Context).pluginInfo?.nodeAddress
				if (!address) throw new TypeError('[core.fs] A Plugin node address is required')
				const directory = `plugins/${pluginNodePhysicalKey(address)}`
				return (requirement) => filesystem.directory(directory, requirement)
			},
		}),
		installRootService(TinyBaseHostService, {
			create: (root) =>
				new TinyBaseRuntime(
					root as RootContext,
					root.service(FsService),
					inputs.tinybase.maxSnapshotBytes,
				),
		}),
		...(inputs.logtape
			? [
					installRootService(Logging, {
						create: (root) => createCoreLoggingRuntime(root as RootContext, inputs.logtape!),
					}),
				]
			: []),
		installScopeService(TinyBaseService, {
			create: (owner) =>
				(owner.root.service(TinyBaseHostService) as TinyBaseRuntime).forOwner(owner as Context),
		}),
		installRootService(PluginRuntimeService, {
			create: (ctx) => {
				const executionConfig = execution.read()
				const builtin = (ctx.service(TinyBaseHostService) as TinyBaseRuntime).lifecycle
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
		services: createCoreContextInstallations(inputs),
	})
	return host.createRoot(inputs.name) as RootContext
}

/** Compile a Core host with an explicit, immutable set of additional services. */
export function createCoreContextHost(
	config: CoreHostConfig & {
		readonly executionBinding?: CorePluginExecutionBinding
		readonly createConfigService?: (root: RootContext) => ConfigService
		readonly createLifecycleHooks?: (root: RootContext) => CorePluginLifecycleHooks
		readonly services?: readonly ServiceInstallation[]
	} = {},
) {
	if (
		config.createConfigService !== undefined &&
		typeof config.createConfigService !== 'function'
	) {
		throw new TypeError('[core] createConfigService must be a function')
	}
	if (config.executionBinding && config.plugins !== undefined)
		throw new TypeError('[core] executionBinding and plugins cannot be supplied together')
	const inputs = resolveCoreRootInputs(config)
	return createContextHost({
		name: inputs.name,
		services: [
			...createCoreContextInstallations(
				inputs,
				config.createLifecycleHooks,
				config.createConfigService,
				config.executionBinding,
			),
			...(config.services ?? []),
		],
	}) as import('@pluxel/context').ContextHost<Context, RootContext>
}

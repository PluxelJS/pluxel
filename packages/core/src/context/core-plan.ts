import {
	createCorePluginExecutionBinding,
	assertCorePluginExecutionBinding,
	type CorePluginExecutionBinding,
} from './plugin-execution'
import { ConfigService } from '../services/config/ConfigService'
import { createEventsBackend } from '../services/events/EventsService'
import { resolveLogTapeConfig, type ResolvedLogTapeConfig } from '../config/logtape'
import { createCoreLoggingRuntime } from './core-logging'
import { PluginService, type PluginServiceConfig } from '../plugins/runtime/PluginService'
import { FsService, snapshotFsConfig } from '../fs/service'
import { TinyBaseRuntime } from '../tinybase/service'
import { resolveTinyBaseOptions } from '../tinybase/options'
import type { TinyBaseOptions } from '../tinybase/types'
import {
	freezeCorePluginLifecycleHooks,
	type CorePluginLifecycleHooks,
} from '../plugins/runtime/plugin-service/HostLifecycle'
import { type ContextHost, type ServiceInstallation } from '@pluxel/context'
import { createContextPlan, createRootContext } from '@pluxel/context/internal'
import { type CoreHostConfig, type Context, type RootContext } from './Context'
import { initializeCoreRootContext, type CoreRuntime } from './core-context'
import { createGenerationContext, createOwnerContext } from './context-factory'

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

/** Cache one fixed facility without moving it into the extension service registry. */
function lazy<T>(name: string, create: () => T): () => T {
	let value: T
	let ready = false
	let constructing = false
	return () => {
		if (ready) return value
		if (constructing) throw new Error(`[core] Construction cycle at ${name}`)
		constructing = true
		try {
			value = create()
			if (value === undefined) throw new TypeError(`[core] ${name} returned undefined`)
			ready = true
			return value
		} finally {
			constructing = false
		}
	}
}

type CoreContextHostConfig = CoreHostConfig & {
	/** One-time Host preparation seam, fixed before Plugin admission. */
	readonly executionBinding?: CorePluginExecutionBinding
	readonly createConfigService?: (root: RootContext) => ConfigService
	readonly createLifecycleHooks?: (root: RootContext) => CorePluginLifecycleHooks
	readonly services?: readonly ServiceInstallation[]
}

function createCoreRuntime(
	root: RootContext,
	inputs: CoreRootInputs,
	config: CoreContextHostConfig,
	execution: CorePluginExecutionBinding,
): CoreRuntime {
	const filesystem = lazy('filesystem', () => new FsService(root, inputs.zenfs))
	const tinybase = lazy(
		'TinyBase',
		() => new TinyBaseRuntime(root, filesystem(), inputs.tinybase.maxSnapshotBytes),
	)
	const events = lazy('events', () => createEventsBackend(root, inputs.events))
	const configService = lazy('configuration', () =>
		config.createConfigService ? config.createConfigService(root) : new ConfigService(root),
	)
	const logging = inputs.logtape
		? lazy('logging', () => createCoreLoggingRuntime(root, inputs.logtape!))
		: undefined
	const plugins = lazy('Plugin runtime', () => {
		const executionConfig = execution.read()
		const builtin = tinybase().lifecycle
		const hooks = freezeCorePluginLifecycleHooks(config.createLifecycleHooks?.(root))
		return new PluginService(root, executionConfig, {
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
	})
	return {
		get fs() {
			return filesystem()
		},
		get tinybase() {
			return tinybase()
		},
		get events() {
			return events()
		},
		get config() {
			return configService()
		},
		get plugins() {
			return plugins()
		},
		get logging() {
			return logging?.()
		},
	}
}

export function createCoreRootContext(config: CoreHostConfig = {}): RootContext {
	return createCoreContextHost(config).createRoot()
}

/** Compile application services alongside Core's fixed Context facilities. No resources are acquired. */
export function createCoreContextHost(
	config: CoreContextHostConfig = {},
): ContextHost<Context, RootContext> {
	for (const key of ['createConfigService', 'createLifecycleHooks'] as const) {
		if (config[key] !== undefined && typeof config[key] !== 'function')
			throw new TypeError(`[core] ${key} must be a function`)
	}
	if (config.executionBinding && config.plugins !== undefined)
		throw new TypeError('[core] executionBinding and plugins cannot be supplied together')
	const inputs = resolveCoreRootInputs(config)
	const execution = config.executionBinding ?? createCorePluginExecutionBinding()
	assertCorePluginExecutionBinding(execution)
	if (!config.executionBinding) execution.bind(inputs.plugins ?? {})
	const factories = Object.freeze({
		createConfigService: config.createConfigService,
		createLifecycleHooks: config.createLifecycleHooks,
	})
	const plan = createContextPlan(inputs.name, config.services ?? [])
	const roots = new WeakSet<RootContext>()
	function assertRoot(root: RootContext): void {
		if (!roots.has(root)) throw new TypeError('[core] Context belongs to a different host')
	}
	return Object.freeze({
		name: inputs.name,
		createRoot(name = inputs.name) {
			const root = createRootContext(plan, name) as RootContext
			initializeCoreRootContext(root, createCoreRuntime(root, inputs, factories, execution))
			roots.add(root)
			return Object.preventExtensions(root)
		},
		createScope(root: RootContext, name: string) {
			assertRoot(root)
			return Object.preventExtensions(createGenerationContext(root, name))
		},
		createChild(parent: Context, name: string) {
			assertRoot(parent.root)
			return Object.preventExtensions(createOwnerContext(parent, name))
		},
	}) as ContextHost<Context, RootContext>
}

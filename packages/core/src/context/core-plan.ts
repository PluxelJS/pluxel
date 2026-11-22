import {
	createCorePluginExecutionBinding,
	assertCorePluginExecutionBinding,
	type CoreExecutionConfig,
	type CorePluginExecutionBinding,
} from './plugin-execution'
import { ConfigService } from '../services/config/ConfigService'
import { createEventsBackend } from '../services/events/EventsService'
import { createCoreLoggingRuntime } from './core-logging'
import { assertPreparedCoreFacilities, type PreparedCoreFacilities } from './core-facilities'
import { assertCoreConfigObject } from './core-config-object'
import { PluginService } from '../plugins/runtime/PluginService'
import { VaultRuntime } from '../vault/runtime'
import { TinyBaseRuntime } from '../tinybase/service'
import { createOutboundHttpRuntime } from '../http/runtime'
import {
	freezeCorePluginLifecycleHooks,
	type CorePluginLifecycleHooks,
} from '../plugins/runtime/plugin-service/HostLifecycle'
import { type ContextHost, type ServiceInstallation } from '@pluxel/context'
import { createContextPlan, createRootContext } from '@pluxel/context/internal'
import { type Context, type RootContext } from './Context'
import { initializeCoreRootContext, requireCoreFilesystem, type CoreRuntime } from './core-context'
import { createGenerationContext, createOwnerContext } from './context-factory'

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

export type CoreContextPlanConfig = Readonly<{
	name?: string
	execution?: CoreExecutionConfig
	/** One-time Host preparation seam, fixed before Plugin admission. */
	executionBinding?: CorePluginExecutionBinding
	createConfigService?: (root: RootContext) => ConfigService
	createLifecycleHooks?: (root: RootContext) => CorePluginLifecycleHooks
	services?: readonly ServiceInstallation[]
}>

const planFields = new Set([
	'name',
	'execution',
	'executionBinding',
	'createConfigService',
	'createLifecycleHooks',
	'services',
])

function createCoreRuntime(
	root: RootContext,
	inputs: PreparedCoreFacilities,
	config: CoreContextPlanConfig,
	execution: CorePluginExecutionBinding,
): CoreRuntime {
	const storage = lazy('storage', () => inputs.createStorage(root))
	const tinybase = lazy(
		'TinyBase',
		() => new TinyBaseRuntime(root, storage(), inputs.tinybase.maxSnapshotBytes),
	)
	const vault = lazy(
		'Vault',
		() => new VaultRuntime(root, inputs.vault, () => requireCoreFilesystem(root)),
	)
	const http = lazy('outbound HTTP', () => createOutboundHttpRuntime(root, inputs.http))
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
		get storage() {
			return storage()
		},
		get tinybase() {
			return tinybase()
		},
		get vault() {
			return vault()
		},
		get http() {
			return http()
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

/** Compile application services alongside the already selected Core facilities. */
export function createCoreContextHostWithFacilities(
	config: CoreContextPlanConfig,
	inputs: PreparedCoreFacilities,
): ContextHost<Context, RootContext> {
	assertCoreConfigObject(config, '[core] Host plan', planFields)
	assertPreparedCoreFacilities(inputs)
	for (const key of ['createConfigService', 'createLifecycleHooks'] as const) {
		if (config[key] !== undefined && typeof config[key] !== 'function')
			throw new TypeError(`[core] ${key} must be a function`)
	}
	const {
		name = 'root',
		execution: configuredExecution,
		executionBinding,
		createConfigService,
		createLifecycleHooks,
		services,
	} = config
	if (typeof name !== 'string' || !name.trim())
		throw new TypeError('[core] name must be a non-empty string')
	if (executionBinding !== undefined && configuredExecution !== undefined)
		throw new TypeError('[core] executionBinding and execution cannot be supplied together')
	const execution =
		executionBinding === undefined ? createCorePluginExecutionBinding() : executionBinding
	assertCorePluginExecutionBinding(execution)
	if (executionBinding === undefined)
		execution.bind(configuredExecution === undefined ? {} : configuredExecution)
	const factories = Object.freeze({ createConfigService, createLifecycleHooks })
	const plan = createContextPlan(name, services ?? [])
	const roots = new WeakSet<RootContext>()
	function assertRoot(root: RootContext): void {
		if (!roots.has(root)) throw new TypeError('[core] Context belongs to a different host')
	}
	return Object.freeze({
		name,
		createRoot(rootName = name) {
			const root = createRootContext(plan, rootName) as RootContext
			initializeCoreRootContext(root, createCoreRuntime(root, inputs, factories, execution))
			roots.add(root)
			return Object.preventExtensions(root)
		},
		createScope(root: RootContext, scopeName: string) {
			assertRoot(root)
			return Object.preventExtensions(createGenerationContext(root, scopeName))
		},
		createChild(parent: Context, childName: string) {
			assertRoot(parent.root)
			return Object.preventExtensions(createOwnerContext(parent, childName))
		},
	}) as ContextHost<Context, RootContext>
}

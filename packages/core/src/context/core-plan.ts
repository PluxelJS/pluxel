import {
	createCorePluginExecutionBinding,
	assertCorePluginExecutionBinding,
	type CorePluginExecutionBinding,
} from './plugin-execution'
import { ConfigService } from '../services/config/ConfigService'
import { createEventsBackend } from '../services/events/EventsService'
import { createCoreLoggingRuntime } from './core-logging'
import { snapshotCoreFacilitiesConfig } from './core-facilities'
import { assertCoreConfigObject } from './core-config-object'
import { PluginService } from '../plugins/runtime/PluginService'
import { FsService } from '../fs/service'
import { VaultRuntime } from '../vault/runtime'
import { TinyBaseRuntime } from '../tinybase/service'
import { createOutboundHttpRuntime } from '../http/runtime'
import {
	freezeCorePluginLifecycleHooks,
	type CorePluginLifecycleHooks,
} from '../plugins/runtime/plugin-service/HostLifecycle'
import { type ContextHost, type ServiceInstallation } from '@pluxel/context'
import { createContextPlan, createRootContext } from '@pluxel/context/internal'
import { type CoreHostConfig, type Context, type RootContext } from './Context'
import { initializeCoreRootContext, type CoreRuntime } from './core-context'
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

type CoreContextHostConfig = CoreHostConfig & {
	/** One-time Host preparation seam, fixed before Plugin admission. */
	readonly executionBinding?: CorePluginExecutionBinding
	readonly createConfigService?: (root: RootContext) => ConfigService
	readonly createLifecycleHooks?: (root: RootContext) => CorePluginLifecycleHooks
	readonly services?: readonly ServiceInstallation[]
}

function createCoreRuntime(
	root: RootContext,
	inputs: ReturnType<typeof snapshotCoreFacilitiesConfig>,
	config: CoreContextHostConfig,
	execution: CorePluginExecutionBinding,
): CoreRuntime {
	const filesystem = lazy('filesystem', () => new FsService(root, inputs.zenfs))
	const tinybase = lazy(
		'TinyBase',
		() => new TinyBaseRuntime(root, filesystem(), inputs.tinybase.maxSnapshotBytes),
	)
	const vault = lazy('Vault', () => new VaultRuntime(root, inputs.vault, filesystem))
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
		get fs() {
			return filesystem()
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

export function createCoreRootContext(config: CoreHostConfig = {}): RootContext {
	return createCoreContextHost(config).createRoot()
}

/** Compile application services alongside Core's fixed Context facilities. No resources are acquired. */
export function createCoreContextHost(
	config: CoreContextHostConfig = {},
	preparedFacilities?: ReturnType<typeof snapshotCoreFacilitiesConfig>,
): ContextHost<Context, RootContext> {
	assertCoreConfigObject(config, '[core] Host configuration')
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
		...facilities
	} = config
	if (typeof name !== 'string' || !name.trim())
		throw new TypeError('[core] name must be a non-empty string')
	if (executionBinding !== undefined && configuredExecution !== undefined)
		throw new TypeError('[core] executionBinding and execution cannot be supplied together')
	if (preparedFacilities !== undefined && Object.keys(facilities).length > 0)
		throw new TypeError('[core] Core facilities must be supplied once')
	const inputs = snapshotCoreFacilitiesConfig(
		preparedFacilities === undefined ? facilities : preparedFacilities,
	)
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

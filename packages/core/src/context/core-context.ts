import type { Context, RootContext } from './Context'
import { LoggerService, type ContextLogger } from '../logger/LoggerService'
import { EffectsService, type EffectsScope } from '../services/effects/EffectsService'
import {
	createEventsServiceView,
	type createEventsBackend,
	type EventsService,
} from '../services/events/EventsService'
import type { ConfigService } from '../services/config/ConfigService'
import type { PluginService } from '../plugins/runtime/PluginService'
import type { FsService, FsPromises, FsRequirement } from '../fs/service'
import type { TinyBaseRuntime } from '../tinybase/service'
import type { VaultRuntime } from '../vault/runtime'
import type { RuntimeLogging } from '../logging/logging'
import { pluginNodePhysicalKey } from '../internal/plugin-address'
import type { OutboundHttpRuntime } from '../http/runtime'

/** Fixed Core facilities. They never participate in the application's service registry. */
export interface CoreRuntime {
	readonly config: ConfigService
	readonly plugins: PluginService
	readonly fs: FsService
	readonly tinybase: TinyBaseRuntime
	readonly vault: VaultRuntime
	readonly http: OutboundHttpRuntime
	readonly events: ReturnType<typeof createEventsBackend>
	readonly logging: RuntimeLogging | undefined
}

type OwnerValues = Pick<Context, 'logger' | 'effects'>
type ContextState = {
	readonly scope: Context
	readonly owner: Context
	logger?: ContextLogger
	effects?: EffectsScope
	events?: EventsService
	fs?: (requirement?: FsRequirement) => Promise<FsPromises>
}

const runtimes = new WeakMap<RootContext, CoreRuntime>()
const contexts = new WeakMap<Context, ContextState>()

export function requireCoreRuntime(ctx: Context): CoreRuntime {
	const runtime = runtimes.get(ctx.root)
	if (!runtime) throw new TypeError('[core] Context does not belong to a Core host')
	return runtime
}

function stateOf(ctx: Context): ContextState {
	const state = contexts.get(ctx)
	if (!state) throw new TypeError('[core] Invalid Core Context')
	return state
}

const properties: PropertyDescriptorMap = {
	logger: {
		get(this: Context) {
			const state = stateOf(this)
			return (state.logger ??= state.owner === this ? new LoggerService(this) : state.owner.logger)
		},
	},
	effects: {
		get(this: Context) {
			const state = stateOf(this)
			return (state.effects ??=
				state.owner === this ? new EffectsService(this) : state.owner.effects)
		},
	},
	events: {
		get(this: Context) {
			const state = stateOf(this)
			return (state.events ??= createEventsServiceView(requireCoreRuntime(this).events, this))
		},
	},
}

const pluginProperties: PropertyDescriptorMap = {
	fs: {
		get(this: Context) {
			const state = stateOf(this)
			if (state.fs) return state.fs
			const address = this.pluginInfo?.nodeAddress
			if (!address) throw new TypeError('[core.fs] A Plugin node address is required')
			const directory = `plugins/${pluginNodePhysicalKey(address)}`
			const filesystem = requireCoreRuntime(this).fs
			return (state.fs = (requirement) => filesystem.directory(directory, requirement))
		},
	},
	vault: {
		get(this: Context) {
			return requireCoreRuntime(this).vault.forOwner(stateOf(this).scope)
		},
	},
	tinybase: {
		get(this: Context) {
			return requireCoreRuntime(this).tinybase.forOwner(stateOf(this).scope)
		},
	},
	wretch: {
		get(this: Context) {
			return requireCoreRuntime(this).http.wretchFor(stateOf(this).scope)
		},
	},
	fetch: {
		get(this: Context) {
			return requireCoreRuntime(this).http.fetchFor(stateOf(this).scope)
		},
	},
}

/** Construction-only binding of the fixed Core fields, before a Context is published. */
export function initializeCoreContext(
	ctx: Context,
	scope: Context = ctx,
	owner: Context = ctx,
	values?: OwnerValues,
): Context {
	if (contexts.has(ctx)) throw new TypeError('[core] Context is already initialized')
	contexts.set(ctx, { scope, owner, ...values })
	Object.defineProperties(ctx, properties)
	if (ctx !== ctx.root) Object.defineProperties(ctx, pluginProperties)
	return ctx
}

export function initializeCoreRootContext(root: RootContext, runtime: CoreRuntime): RootContext {
	runtimes.set(root, runtime)
	initializeCoreContext(root)
	Object.defineProperty(root, 'logging', { get: () => runtime.logging })
	return root
}

export function coreContextScope(ctx: Context): Context {
	return stateOf(ctx).scope
}

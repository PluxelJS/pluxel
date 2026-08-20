import type { Context } from '@pluxel/context'
import { closeOwnerInvocations } from '../../internal/owner-invocations'
import {
	EffectsDisposedError,
	type Cleanup,
	type DisposableLike,
} from '../../services/effects/EffectsService'
import { CONFIGS, type ConfigHost } from './ConfigHost'
import { PluginHost } from './PluginHost'
import {
	createRootPartHost,
	finalizePluginParts,
	startPluginParts,
	type PartHost,
} from './PluginPart'
import { FORK_CTX, LATE_INIT_CLEANUP_ERROR, PLUGIN_CTX } from './symbols'

const PLUGIN_HOST = Symbol('pluxel:plugin:pluginHost')
const INIT_ACTIVE = Symbol('pluxel:plugin:initActive')
const PART_HOST = Symbol('pluxel:plugin:partHost')
type RootPartHost = ReturnType<typeof createRootPartHost>

export { FORK_CTX, PLUGIN_CTX } from './symbols'

export type PluginCleanup = void | Cleanup | DisposableLike

export interface PluginLifecycleRuntime<_C extends Context = Context> {
	init?: (signal: AbortSignal) => PluginCleanup | Promise<PluginCleanup>
	drain: () => Promise<void>
	subscribeErrors?: (cb: (err: unknown) => void) => undefined | (() => void)
}

export type PluginContextOf<P extends BasePlugin> = P extends BasePlugin<infer C> ? C : Context

function isDisposable(value: unknown): value is DisposableLike {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as { dispose?: unknown }).dispose === 'function'
	)
}

async function disposeLate(resource: Cleanup | DisposableLike): Promise<void> {
	if (typeof resource === 'function') await resource()
	else await resource.dispose()
}

function lateCleanupError(cause: unknown): Error {
	const detail = cause instanceof Error ? cause.message : String(cause)
	const error = new Error(`Late Plugin init cleanup failed: ${detail}`, { cause }) as Error & {
		[LATE_INIT_CLEANUP_ERROR]?: true
	}
	Object.defineProperty(error, LATE_INIT_CLEANUP_ERROR, { value: true })
	return error
}

async function adoptCleanup(ctx: Context, resource: PluginCleanup): Promise<void> {
	if (resource === undefined) return
	try {
		if (typeof resource === 'function') ctx.effects.defer(resource)
		else if (isDisposable(resource)) ctx.effects.own(resource)
		else throw new TypeError('[pluxel/core] Plugin init() returned an invalid cleanup resource')
	} catch (error) {
		if (!(error instanceof EffectsDisposedError)) throw error
		try {
			await disposeLate(resource as Cleanup | DisposableLike)
		} catch (cause) {
			throw lateCleanupError(cause)
		}
	}
}

export abstract class BasePlugin<C extends Context = Context> {
	static [FORK_CTX]: () => Context
	protected [PLUGIN_CTX]!: C
	private [INIT_ACTIVE] = false
	private [PLUGIN_HOST]?: PluginHost
	private [PART_HOST]: RootPartHost

	constructor() {
		if (BasePlugin[FORK_CTX] === undefined)
			throw new Error("Don't instantiate BasePlugin directly.")
		this[PLUGIN_CTX] = BasePlugin[FORK_CTX]() as C
		this[PART_HOST] = createRootPartHost(this, this[PLUGIN_CTX])
	}

	public get ctx(): C {
		return this[PLUGIN_CTX]
	}

	public get plugins(): PluginHost {
		return (this[PLUGIN_HOST] ??= new PluginHost(this.ctx, () => this[INIT_ACTIVE]))
	}

	public get parts(): PartHost<this> {
		return this[PART_HOST] as unknown as PartHost<this>
	}

	public get configs(): ConfigHost {
		return CONFIGS
	}

	protected get caller() {
		return this.ctx.caller
	}

	protected init?(_abort: AbortSignal): PluginCleanup | Promise<PluginCleanup>

	static getLifecycleRuntime<P extends BasePlugin>(
		plugin: P,
	): PluginLifecycleRuntime<PluginContextOf<P>> {
		const ctx = plugin[PLUGIN_CTX] as PluginContextOf<P>
		const extended = ctx as unknown as { onError?: (cb: (err: unknown) => void) => unknown }
		const onError = extended.onError
		const parts = plugin[PART_HOST]
		finalizePluginParts(parts)
		return {
			init: async (signal) => {
				plugin[INIT_ACTIVE] = true
				try {
					await startPluginParts(parts, signal)
					if (typeof plugin.init === 'function') {
						const cleanup = await plugin.init(signal)
						await adoptCleanup(ctx, cleanup)
					}
				} finally {
					plugin[INIT_ACTIVE] = false
				}
			},
			drain: async () => {
				await closeOwnerInvocations(ctx)
				await ctx.effects.dispose()
			},
			subscribeErrors:
				typeof onError === 'function'
					? (cb) => {
							const off = onError.call(ctx, cb)
							return typeof off === 'function' ? (off as () => void) : undefined
						}
					: undefined,
		}
	}
}

export abstract class ForkablePlugin<C extends Context = Context> extends BasePlugin<C> {}

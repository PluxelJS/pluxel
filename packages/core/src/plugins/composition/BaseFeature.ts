import type { Context } from '@pluxel/context'
import { ConfigHost } from './ConfigHost'
import { getDeclaredConfigKeys, getFeatureNamespace } from '../decorators/decorator/api'
import type { AnyCtor } from '../decorators/decorator/shared'

export type FeatureCtor<T> = new (ctx: Context, ...args: unknown[]) => T

const HOST_BOUND_FEATURE = Symbol.for('pluxel:feature:hostBound')

export function isHostBoundFeature(ctor: unknown): boolean {
	if (!ctor) return false
	if (typeof ctor !== 'function' && typeof ctor !== 'object') return false
	return Boolean((ctor as Record<symbol, unknown>)[HOST_BOUND_FEATURE])
}

class FeatureScope {
	private disposables = new Set<() => void>()

	constructor(private readonly ctx: Context) {}

	collectEffect(fn: () => void): () => void {
		this.disposables.add(fn)
		return () => {
			this.disposables.delete(fn)
		}
	}

	disposeAll(): void {
		if (this.disposables.size === 0) return
		const current = this.disposables
		this.disposables = new Set()
		for (const fn of current) {
			try {
				fn()
			} catch (error) {
				this.ctx.logger.error('feature dispose error', { error })
			}
		}
	}
}

export abstract class BaseFeature<C extends Context = Context> {
	public readonly scope: { collectEffect: (fn: () => void) => () => void; disposeAll: () => void }
	private static readonly CONFIG_HOST = Symbol.for('pluxel:feature:configHost')

	constructor(public readonly ctx: C) {
		const scope = new FeatureScope(ctx)
		this.scope = scope
		// Ensure feature cleanups run with the owning plugin scope.
		this.ctx.collectEffect(() => scope.disposeAll())
	}

	/** Config declaration helper: `foo = this.configs.use(schema)` */
	public get configs(): ConfigHost {
		const self = this as unknown as { [BaseFeature.CONFIG_HOST]?: ConfigHost }
		const existing = self[BaseFeature.CONFIG_HOST]
		if (existing && existing.ctx === (this.ctx as unknown as Context)) return existing

		const host = new ConfigHost(this.ctx as unknown as Context)
		Object.defineProperty(this, BaseFeature.CONFIG_HOST, {
			value: host,
			writable: false,
			enumerable: false,
			configurable: false,
		})
		return host
	}

	/**
	 * Inject feature config values from the owning plugin's config panel.
	 *
	 * Called by FeatureHost *after* the feature instance is fully constructed
	 * (so derived class field initializers can't clobber injected values).
	 */
	public __injectConfigsFromHostPlugin(): void {
		const ctor = (this as { constructor?: unknown }).constructor
		if (typeof ctor !== 'function') return

		const keys = getDeclaredConfigKeys(ctor as unknown as AnyCtor)
		if (keys.length === 0) return

		const ns = getFeatureNamespace(ctor as unknown as AnyCtor)

		const configService = (this.ctx as unknown as { configService?: unknown })?.configService as
			| { getConfig?: (name?: string) => unknown }
			| undefined
		if (!configService || typeof configService.getConfig !== 'function') return

		const record = configService.getConfig()
		if (!record || typeof record !== 'object') return

		for (let i = 0; i < keys.length; i++) {
			const fieldName = keys[i]!
			;(this as unknown as Record<string, unknown>)[fieldName] = (
				record as Record<string, unknown>
			)[`${ns}.${fieldName}`]
		}
	}

	dispose(): void {
		this.scope.disposeAll()
	}
}

/**
 * Convenience base class for "host-bound" features.
 *
 * When used via `this.features.use(FeatureCtor)` on a plugin instance, FeatureHost can
 * auto-inject the owning plugin instance as the second constructor argument.
 */
export abstract class HostBoundFeature<Host, C extends Context = Context> extends BaseFeature<C> {
	static readonly [HOST_BOUND_FEATURE] = true
	constructor(
		ctx: C,
		public readonly host: Host,
		..._args: unknown[]
	) {
		super(ctx)
	}
}

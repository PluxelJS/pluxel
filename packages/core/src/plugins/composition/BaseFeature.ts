import type { Context } from '@pluxel/context'
import { getDeclaredConfigKeys, getFeatureNamespace } from '../decorators/decorator/api'
import type { AnyCtor } from '../decorators/decorator/shared'
import { CONFIGS, type ConfigHost } from './ConfigHost'

export type FeatureCtor<T> = new (ctx: Context, ...args: unknown[]) => T

const HOST_BOUND_FEATURE = Symbol.for('pluxel:feature:hostBound')
const INJECT_PLAN = new WeakMap<AnyCtor, { keys: readonly string[]; prefix: string }>()

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

	constructor(public readonly ctx: C) {
		const scope = new FeatureScope(ctx)
		this.scope = scope
		// Ensure feature cleanups run with the owning plugin scope.
		this.ctx.collectEffect(() => scope.disposeAll())
	}

	/** Config declaration helper: `foo = this.configs.use(schema)` */
	public get configs(): ConfigHost {
		return CONFIGS
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

		let plan = INJECT_PLAN.get(ctor as unknown as AnyCtor)
		if (!plan) {
			const keys = getDeclaredConfigKeys(ctor as unknown as AnyCtor)
			if (keys.length === 0) return
			const ns = getFeatureNamespace(ctor as unknown as AnyCtor)
			plan = { keys, prefix: `${ns}.` }
			INJECT_PLAN.set(ctor as unknown as AnyCtor, plan)
		}

		const record = this.ctx.configService.tryGetValidatedConfig()
		if (!record || typeof record !== 'object') return

		for (let i = 0; i < plan.keys.length; i++) {
			const fieldName = plan.keys[i]!
			;(this as unknown as Record<string, unknown>)[fieldName] = (
				record as Record<string, unknown>
			)[plan.prefix + fieldName]
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

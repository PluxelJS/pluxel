import type { Context } from '@pluxel/context'
import type { Cleanup, EffectsScope } from '../../services/effects/EffectsService'
import {
	getDeclaredConfigBindings,
	getDeclaredConfigKeys,
	getFeatureNamespace,
} from '../decorators/decorator/api'
import type { AnyCtor } from '../decorators/decorator/shared'
import { CONFIGS, type ConfigHost } from './ConfigHost'

export type FeatureCtor<T> = new (ctx: Context, ...args: unknown[]) => T

const HOST_BOUND_FEATURE = Symbol.for('pluxel:feature:hostBound')
const INJECT_PLAN = new WeakMap<
	AnyCtor,
	{ keys: ReadonlyArray<{ field: string; keys: readonly string[] }>; prefix: string }
>()

export function isHostBoundFeature(ctor: unknown): boolean {
	if (!ctor) return false
	if (typeof ctor !== 'function' && typeof ctor !== 'object') return false
	return Boolean((ctor as Record<symbol, unknown>)[HOST_BOUND_FEATURE])
}

export abstract class BaseFeature<C extends Context = Context> {
	public readonly effects: EffectsScope
	public readonly scope: {
		collectEffect: (fn: Cleanup) => () => void
		disposeAll: () => void
	}

	constructor(public readonly ctx: C) {
		const tag = (() => {
			const ctor = (this as { constructor?: unknown }).constructor
			const name = typeof ctor === 'function' ? ctor.name : 'Feature'
			return name ? `feature:${name}` : 'feature'
		})()

		const effects = this.ctx.effects.scope({ tag })
		this.effects = effects

		const disposeAll = () => {
			void effects.dispose().catch((error) => {
				this.ctx.logger.error('feature dispose error', { error })
			})
		}

		this.scope = {
			collectEffect: (fn) => {
				const guard = effects.defer(fn)
				return () => guard.cancel()
			},
			disposeAll,
		}
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
			// Prefer explicit bindings; fall back to raw keys for legacy/edge cases.
			const bindings = getDeclaredConfigBindings(ctor as unknown as AnyCtor)
			const entries: Array<{ field: string; keys: readonly string[] }> = []
			if (bindings) {
				for (const [field, keys] of Object.entries(bindings)) {
					entries.push({ field, keys })
				}
			} else {
				const keys = getDeclaredConfigKeys(ctor as unknown as AnyCtor)
				for (let i = 0; i < keys.length; i++) entries.push({ field: keys[i]!, keys: [keys[i]!] })
			}
			if (entries.length === 0) return
			const ns = getFeatureNamespace(ctor as unknown as AnyCtor)
			plan = { keys: entries, prefix: `${ns}.` }
			INJECT_PLAN.set(ctor as unknown as AnyCtor, plan)
		}

		const record = this.ctx.configService.tryGetValidatedConfig()
		if (!record || typeof record !== 'object') return

		for (let i = 0; i < plan.keys.length; i++) {
			const { field, keys } = plan.keys[i]!
			if (keys.length === 0) {
				;(this as unknown as Record<string, unknown>)[field] = {}
				continue
			}
			if (keys.length === 1) {
				;(this as unknown as Record<string, unknown>)[field] = (record as Record<string, unknown>)[
					plan.prefix + keys[0]!
				]
				continue
			}
			const obj: Record<string, unknown> = Object.create(null)
			for (let j = 0; j < keys.length; j++) {
				const k = keys[j]!
				obj[k] = (record as Record<string, unknown>)[plan.prefix + k]
			}
			;(this as unknown as Record<string, unknown>)[field] = obj
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

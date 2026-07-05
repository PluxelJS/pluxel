import type { Context } from '@pluxel/context'
import type { Cleanup, EffectsScope } from '../../services/effects/EffectsService'
import {
	getDeclaredConfigBindings,
	getDeclaredConfigKeys,
	getFeatureNamespace,
} from '../decorators/decorator/api'
import type { AnyCtor } from '../decorators/decorator/shared'
import { CONFIGS, type ConfigHost } from './ConfigHost'
import { FEATURE_CONFIG_INJECTOR } from './featureConfigInjection'

export type FeatureCtor<T> = new (ctx: Context, ...args: unknown[]) => T

const HOST_BOUND_FEATURE = Symbol.for('pluxel:feature:hostBound')
type FeatureConfigBinding = { field: string; keys: readonly string[] }
type FeatureConfigInjectPlan = {
	bindings: readonly FeatureConfigBinding[]
	prefix: string
}
const INJECT_PLAN = new WeakMap<AnyCtor, FeatureConfigInjectPlan>()

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
	public [FEATURE_CONFIG_INJECTOR](): void {
		const ctor = (this as { constructor?: unknown }).constructor
		if (typeof ctor !== 'function') return

		const plan = getFeatureConfigInjectPlan(ctor as unknown as AnyCtor)
		if (!plan) return

		const record = this.ctx.configService.tryGetValidatedConfig()
		if (!record || typeof record !== 'object') return

		applyFeatureConfigInjectPlan(this, plan, record as Record<string, unknown>)
	}

	dispose(): void {
		this.scope.disposeAll()
	}
}

function getFeatureConfigInjectPlan(ctor: AnyCtor): FeatureConfigInjectPlan | undefined {
	let plan = INJECT_PLAN.get(ctor)
	if (plan) return plan

	const bindings = collectFeatureConfigBindings(ctor)
	if (bindings.length === 0) return undefined

	plan = { bindings, prefix: `${getFeatureNamespace(ctor)}.` }
	INJECT_PLAN.set(ctor, plan)
	return plan
}

function collectFeatureConfigBindings(ctor: AnyCtor): FeatureConfigBinding[] {
	// Prefer explicit bindings; fall back to raw keys for legacy/edge cases.
	const bindings = getDeclaredConfigBindings(ctor)
	if (bindings) {
		const entries: FeatureConfigBinding[] = []
		for (const [field, keys] of Object.entries(bindings)) entries.push({ field, keys })
		return entries
	}

	const keys = getDeclaredConfigKeys(ctor)
	const entries: FeatureConfigBinding[] = []
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i]!
		entries.push({ field: key, keys: [key] })
	}
	return entries
}

function applyFeatureConfigInjectPlan(
	target: object,
	plan: FeatureConfigInjectPlan,
	record: Record<string, unknown>,
): void {
	const targetRecord = target as Record<string, unknown>
	for (let i = 0; i < plan.bindings.length; i++) {
		const { field, keys } = plan.bindings[i]!
		targetRecord[field] = createFeatureConfigBindingValue(record, plan.prefix, keys)
	}
}

function createFeatureConfigBindingValue(
	record: Record<string, unknown>,
	prefix: string,
	keys: readonly string[],
): unknown {
	if (keys.length === 0) return {}
	if (keys.length === 1) return record[prefix + keys[0]!]

	const value: Record<string, unknown> = Object.create(null)
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i]!
		value[key] = record[prefix + key]
	}
	return value
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

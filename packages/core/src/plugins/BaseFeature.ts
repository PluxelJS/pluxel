import type { Context } from '@pluxel/context'
import { ConfigHost } from './ConfigHost'
import { getDeclaredConfigKeys, getFeatureNamespace } from './internal/decorator/api'

export type FeatureCtor<T> = new (ctx: Context, ...args: any[]) => T

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
		this.scope = {
			collectEffect: (fn) => scope.collectEffect(fn),
			disposeAll: () => scope.disposeAll(),
		}
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

	/** Preferred alias for config declarations: `foo = this.config.use(schema)` */
	public get config(): ConfigHost {
		return this.configs
	}

	/**
	 * Inject feature config values from the owning plugin's config panel.
	 *
	 * Called by FeatureHost *after* the feature instance is fully constructed
	 * (so derived class field initializers can't clobber injected values).
	 */
	public __injectConfigsFromHostPlugin(): void {
		const ctor = (this as any)?.constructor as Function | undefined
		if (typeof ctor !== 'function') return

		const keys = getDeclaredConfigKeys(ctor)
		if (keys.length === 0) return

		const ns = getFeatureNamespace(ctor)

		const configService = (this.ctx as any)?.configService as { getConfig?: (name?: string) => any }
		if (!configService || typeof configService.getConfig !== 'function') return

		const record = configService.getConfig()
		if (!record || typeof record !== 'object') return

		for (let i = 0; i < keys.length; i++) {
			const fieldName = keys[i]!
			;(this as any)[fieldName] = (record as any)[`${ns}.${fieldName}`]
		}
	}

	dispose(): void {
		this.scope.disposeAll()
	}
}

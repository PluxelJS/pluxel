import type { Context } from '@pluxel/context'
import {
	getDeclaredConfigKeys,
	getRequiredPluginDependencies,
	getUsedFeatures,
} from '../decorators/decorator/api'
import { __DEV__, type AnyCtor } from '../decorators/decorator/shared'
import type { PluginIdentifier } from '../types'
import type { BaseFeature, FeatureCtor, HostBoundFeature } from './BaseFeature'
import { isHostBoundFeature } from './BaseFeature'
import { PLUGIN_CTX } from './BasePlugin'

const FEATURE_DECLARATION_POLICY = Symbol.for('pluxel:feature:declarationPolicy')
type FeatureDeclarationPolicy = 'off' | 'warn' | 'error'

type DepWatcher = {
	lastRaw?: unknown
	cbs: Map<(dep: unknown) => unknown, { cleanup?: () => void }>
	unsub?: () => void
}

type HostBoundFeatureCtor<T extends BaseFeature, Host> = new (
	ctx: Context,
	host: Host,
	...args: unknown[]
) => T

export class FeatureHost<Host = unknown> {
	private readonly instances = new Map<FeatureCtor<BaseFeature>, BaseFeature>()
	private readonly warned = new Set<FeatureCtor<BaseFeature>>()
	private readonly depWatchers = new Map<PluginIdentifier, DepWatcher>()
	private readonly depViewCache = new WeakMap<object, unknown>()

	constructor(
		public readonly ctx: Context,
		private readonly ownerCtor?: AnyCtor,
		private readonly ownerInstance?: Host,
	) {
		// Ensure all features are disposed with the owning plugin scope.
		this.ctx.collectEffect(() => this.disposeAll())
	}

	use<T extends BaseFeature>(Ctor: FeatureCtor<T>, ...args: unknown[]): T
	use<T extends HostBoundFeature<Host>>(Ctor: HostBoundFeatureCtor<T, Host>, ...args: unknown[]): T
	use<T extends BaseFeature>(
		Ctor: FeatureCtor<T> | HostBoundFeatureCtor<T, Host>,
		...args: unknown[]
	): T {
		const key = Ctor as unknown as FeatureCtor<BaseFeature>
		const existing = this.instances.get(key)
		if (existing) return existing as T

		this.warnIfUndeclared(key)

		const finalArgs =
			this.ownerInstance && isHostBoundFeature(Ctor) ? [this.ownerInstance, ...args] : args

		const AnyCtor = Ctor as unknown as new (ctx: Context, ...args: unknown[]) => T
		const instance = new AnyCtor(this.ctx, ...finalArgs)
		this.tryInjectConfigsIntoFeature(instance)
		this.instances.set(key, instance)
		return instance
	}

	/** @internal Called by the registry after config validation/injection. */
	__injectConfigsFromHostPlugin(): void {
		if (this.instances.size === 0) return
		for (const feature of this.instances.values()) this.tryInjectConfigsIntoFeature(feature)
	}

	private tryInjectConfigsIntoFeature(instance: BaseFeature): void {
		try {
			const maybe = instance as unknown as { __injectConfigsFromHostPlugin?: () => void }
			if (typeof maybe.__injectConfigsFromHostPlugin === 'function') {
				maybe.__injectConfigsFromHostPlugin()
			}
		} catch (error) {
			this.ctx.logger.error('feature config inject error', { error })
		}
	}

	/**
	 * Friendly dependency accessor for other plugins.
	 *
	 * - `dep(DepPlugin)` returns the dependency instance (or `undefined`).
	 * - `dep(DepPlugin, cb)` runs cb when the dep becomes available (and re-runs when it changes across commits).
	 *   If `cb` returns a cleanup function, it will be called when the dep disappears or changes.
	 *
	 * This is meant for optional integrations without requiring authors to reason about commit timing.
	 */
	dep<T extends PluginIdentifier>(id: T): InstanceType<T> | undefined
	dep<T extends PluginIdentifier>(id: T, cb: (dep: InstanceType<T>) => void): () => void
	dep<T extends PluginIdentifier>(id: T, cb: (dep: InstanceType<T>) => () => void): () => void
	dep<T extends PluginIdentifier>(
		id: T,
		cb?: (dep: InstanceType<T>) => unknown,
	): InstanceType<T> | undefined | (() => void) {
		if (!cb) return this.maybeDep(id)

		let watcher = this.depWatchers.get(id)
		if (!watcher) {
			watcher = { lastRaw: undefined, cbs: new Map(), unsub: undefined }
			this.depWatchers.set(id, watcher)
		}

		const cbAny = cb as unknown as (dep: unknown) => unknown
		watcher.cbs.set(cbAny, {})

		const hadSub = Boolean(watcher.unsub)
		if (!hadSub) {
			const registry = (this.ctx as unknown as { registry?: unknown })?.registry as
				| {
						watchInstance?: (id: PluginIdentifier, cb: (instance: unknown) => void) => () => void
				  }
				| undefined
			if (!registry || typeof registry.watchInstance !== 'function') {
				throw new Error('[pluxel/core] FeatureHost.dep requires PluginService.watchInstance')
			}
			watcher.unsub = registry.watchInstance(id, (instance) =>
				this.flushDepWatcherRaw(watcher, instance),
			)
		} else if (watcher.lastRaw !== undefined) {
			this.invokeDepCb(
				watcher,
				cbAny,
				this.withCaller(watcher.lastRaw as InstanceType<PluginIdentifier>),
			)
		}

		let active = true
		const off = () => {
			if (!active) return
			active = false
			const current = this.depWatchers.get(id)
			if (!current) return
			const entry = current.cbs.get(cbAny)
			if (entry?.cleanup) {
				try {
					entry.cleanup()
				} catch (error) {
					this.ctx.logger.error('feature dep cleanup error', { error })
				}
			}
			current.cbs.delete(cbAny)
			if (current.cbs.size === 0) {
				if (current.unsub) {
					try {
						current.unsub()
					} catch {
						// ignore
					}
				}
				this.depWatchers.delete(id)
			}
		}

		// Auto-collect: plugin authors usually don't want to track unsubs manually.
		this.ctx.scope.collectEffect(off)

		return off
	}

	get<T extends BaseFeature>(Ctor: FeatureCtor<T>): T | undefined {
		return this.instances.get(Ctor) as T | undefined
	}

	dispose<T extends BaseFeature>(Ctor: FeatureCtor<T>): void {
		const existing = this.instances.get(Ctor)
		if (!existing) return
		this.instances.delete(Ctor)
		existing.dispose()
	}

	disposeAll(): void {
		for (const watcher of this.depWatchers.values()) {
			if (watcher.unsub) {
				try {
					watcher.unsub()
				} catch {
					// ignore
				}
				watcher.unsub = undefined
			}
			this.disposeWatcherCbs(watcher)
		}
		this.depWatchers.clear()

		if (this.instances.size === 0) return
		const current = this.instances
		this.instances.clear()
		for (const feature of current.values()) {
			try {
				feature.dispose()
			} catch (error) {
				this.ctx.logger.error('feature dispose error', { error })
			}
		}
	}

	private warnIfUndeclared<T extends BaseFeature>(Ctor: FeatureCtor<T>): void {
		const policy =
			((this.ctx as unknown as Record<symbol, unknown>)?.[FEATURE_DECLARATION_POLICY] as
				| FeatureDeclarationPolicy
				| undefined) ?? (__DEV__ ? 'warn' : 'off')
		if (policy === 'off') return

		// If we don't know the owning plugin ctor, we can't validate declaration-time metadata.
		if (!this.ownerCtor) return
		if (this.warned.has(Ctor)) return

		// If this feature does not declare config fields or decorator-required deps,
		// it can be purely runtime-composed without any declaration-time metadata.
		const ctor = Ctor as unknown as AnyCtor
		const hasConfig = getDeclaredConfigKeys(ctor).length > 0
		const hasDeps = getRequiredPluginDependencies(ctor, { inherit: true }).length > 0
		if (!hasConfig && !hasDeps) return

		const declared = getUsedFeatures(this.ownerCtor)
		if (declared.includes(ctor)) return

		this.warned.add(Ctor)

		const info = (this.ctx as unknown as { pluginInfo?: { id?: string } }).pluginInfo
		const payload = {
			ownerId: info?.id,
			ownerCtor: this.ownerCtor.name ?? '<unknown>',
			feature: (ctor as { name?: string }).name ?? '<anonymous>',
			hasConfig,
			hasDeps,
			hint: 'Use @UseFeature(FeatureCtor) (or ensure configSourcePlugin injects __registerUsedFeatures__ via a class-field `this.features.use(...)`).',
		}

		if (policy === 'error') {
			throw new Error(
				`Feature used without declaration-time registration: ${payload.ownerCtor} -> ${payload.feature}. ${payload.hint}`,
			)
		}

		this.ctx.logger.warn('feature used without declaration-time registration', payload)
	}

	private flushDepWatcherRaw(watcher: DepWatcher, raw: unknown): void {
		if (!raw) {
			if (watcher.lastRaw) this.disposeWatcherCbs(watcher)
			watcher.lastRaw = undefined
			return
		}

		if (watcher.lastRaw === raw) return
		this.disposeWatcherCbs(watcher)
		watcher.lastRaw = raw

		const view = this.withCaller(raw as unknown as InstanceType<PluginIdentifier>)
		for (const cb of watcher.cbs.keys()) this.invokeDepCb(watcher, cb, view)
	}

	private invokeDepCb(watcher: DepWatcher, cb: (dep: unknown) => unknown, depView: unknown): void {
		const entry = watcher.cbs.get(cb)
		if (!entry) return
		try {
			const cleanup = cb(depView)
			entry.cleanup = typeof cleanup === 'function' ? (cleanup as () => void) : undefined
		} catch (error) {
			this.ctx.logger.error('feature dep callback error', { error })
		}
	}

	private maybeDep<T extends PluginIdentifier>(id: T): InstanceType<T> | undefined {
		const raw = this.getRawDep(id)
		if (!raw) return undefined
		return this.withCaller(raw)
	}

	private getRawDep<T extends PluginIdentifier>(id: T): InstanceType<T> | undefined {
		const registry = (this.ctx as unknown as { registry?: unknown })?.registry as
			| { getInstance?: (x: unknown) => unknown }
			| undefined
		return (registry?.getInstance?.(id) as InstanceType<T> | undefined) ?? undefined
	}

	private withCaller<T extends PluginIdentifier>(raw: InstanceType<T>): InstanceType<T> {
		// Only inject caller context when this FeatureHost belongs to a plugin instance.
		if (!this.ownerInstance) return raw

		if (raw && (typeof raw === 'object' || typeof raw === 'function')) {
			const cached = this.depViewCache.get(raw as unknown as object)
			if (cached) return cached as InstanceType<T>
		}

		const baseCtx = (raw as unknown as Record<symbol, unknown>)?.[PLUGIN_CTX] as Context | undefined
		if (!baseCtx || typeof baseCtx !== 'object') return raw

		const view = Object.create(baseCtx as object) as Context
		view.caller = this.ctx
		const wrapped = Object.create(raw as object, {
			ctx: {
				value: view,
				writable: false,
				enumerable: false,
				configurable: false,
			},
		}) as InstanceType<T>

		if (raw && (typeof raw === 'object' || typeof raw === 'function')) {
			this.depViewCache.set(raw as unknown as object, wrapped)
		}

		return wrapped
	}

	private disposeWatcherCbs(watcher: DepWatcher): void {
		for (const entry of watcher.cbs.values()) {
			if (!entry.cleanup) continue
			try {
				entry.cleanup()
			} catch (error) {
				this.ctx.logger.error('feature dep cleanup error', { error })
			} finally {
				entry.cleanup = undefined
			}
		}
	}
}

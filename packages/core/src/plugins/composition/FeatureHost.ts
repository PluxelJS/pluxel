import type { Context } from '@pluxel/context'
import { isConfigSentinel } from './ConfigHost'
import {
	getDeclaredConfigKeys,
	getRequiredPluginDependencies,
	getUsedFeatures,
} from '../decorators/decorator/api'
import { __DEV__, type AnyCtor } from '../decorators/decorator/shared'
import type { PluginIdentifier } from '../types'
import {
	isHostBoundFeature,
	type BaseFeature,
	type FeatureCtor,
	type HostBoundFeature,
} from './BaseFeature'
import { callFeatureConfigInjector, FEATURE_CONFIG_INJECTOR } from './featureConfigInjection'
import { PLUGIN_CTX } from './symbols'

const FEATURE_DECLARATION_POLICY = Symbol.for('pluxel:feature:declarationPolicy')
type FeatureDeclarationPolicy = 'off' | 'warn' | 'error'

type DepWatcher = {
	lastRaw?: unknown
	cbs: Map<(dep: unknown) => unknown, (() => void) | undefined>
	unsub?: () => void
}

type HostBoundFeatureCtor<T extends BaseFeature, Host> = new (
	ctx: Context,
	host: Host,
	...args: unknown[]
) => T
type MaybePromise<T> = T | Promise<T>
const OPTIONAL_FEATURE_SPEC = Symbol.for('pluxel:feature:optionalSpec')

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
	return (
		Boolean(value) &&
		(typeof value === 'object' || typeof value === 'function') &&
		typeof (value as { then?: unknown }).then === 'function'
	)
}

type PluginRegistryLike = {
	getInstance?: (id: unknown) => unknown
	isRegistered?: (id: PluginIdentifier) => boolean
	watchInstance?: (id: PluginIdentifier, cb: (instance: unknown) => void) => () => void
}

export type FeatureUseCtor<T extends BaseFeature, Host = unknown> =
	| FeatureCtor<T>
	| HostBoundFeatureCtor<T, Host>

type OptionalFeatureSpecInput<T extends BaseFeature, Host = unknown> = {
	key: string
	requires?: readonly PluginIdentifier[]
	when?: boolean | ((ctx: Context) => MaybePromise<boolean>)
	load: () => Promise<FeatureUseCtor<T, Host>>
}

export type OptionalFeatureSpec<T extends BaseFeature, Host = unknown> = Readonly<
	OptionalFeatureSpecInput<T, Host> & {
		readonly [OPTIONAL_FEATURE_SPEC]: true
	}
>

export function defineOptionalFeature<T extends BaseFeature, Host = unknown>(
	spec: OptionalFeatureSpecInput<T, Host>,
): OptionalFeatureSpec<T, Host> {
	const key = typeof spec.key === 'string' ? spec.key.trim() : ''
	if (!key) throw new Error('[pluxel/core] Optional feature key must be a non-empty string')
	if (typeof spec.load !== 'function') {
		throw new TypeError('[pluxel/core] Optional feature load must be a function')
	}
	if (
		spec.when !== undefined &&
		typeof spec.when !== 'boolean' &&
		typeof spec.when !== 'function'
	) {
		throw new TypeError('[pluxel/core] Optional feature when must be a boolean or function')
	}
	const requires = spec.requires ? Object.freeze([...spec.requires]) : undefined
	return Object.freeze({
		...spec,
		key,
		requires,
		[OPTIONAL_FEATURE_SPEC]: true as const,
	}) as OptionalFeatureSpec<T, Host>
}

function isOptionalFeatureSpec<T extends BaseFeature, Host = unknown>(
	value: unknown,
): value is OptionalFeatureSpec<T, Host> {
	return (
		Boolean(value) &&
		(typeof value === 'object' || typeof value === 'function') &&
		(value as Record<symbol, unknown>)[OPTIONAL_FEATURE_SPEC] === true
	)
}

export class FeatureHost<Host = unknown> {
	private readonly instances = new Map<FeatureCtor<BaseFeature>, BaseFeature>()
	private readonly optionalLoads = new Map<string, Promise<BaseFeature | undefined>>()
	private readonly optionalCtors = new Map<string, FeatureCtor<BaseFeature>>()
	private readonly optionalSpecs = new Map<string, OptionalFeatureSpec<BaseFeature, Host>>()
	private readonly warned = new Set<FeatureCtor<BaseFeature>>()
	private readonly depWatchers = new Map<PluginIdentifier, DepWatcher>()
	private readonly depViewCache = new WeakMap<object, unknown>()
	private readonly depCtxDesc: PropertyDescriptor = {
		value: null,
		writable: false,
		enumerable: false,
		configurable: false,
	}
	private disposed = false
	private disposeEpoch = 0
	private registry?: PluginRegistryLike

	constructor(
		public readonly ctx: Context,
		private readonly ownerCtor?: AnyCtor,
		private readonly ownerInstance?: Host,
	) {
		// Ensure all features are disposed with the owning plugin scope.
		this.ctx.effects.defer(() => this.disposeAll())
	}

	private getRegistry(): PluginRegistryLike | undefined {
		if (this.registry) return this.registry
		const reg = (this.ctx as unknown as { registry?: unknown })?.registry as
			| PluginRegistryLike
			| undefined
		// Don't cache "missing": some hosts attach registry after ctx creation.
		if (reg && (typeof reg === 'object' || typeof reg === 'function')) this.registry = reg
		return this.registry
	}

	use<T extends BaseFeature>(Ctor: FeatureCtor<T>, ...args: unknown[]): T
	use<T extends HostBoundFeature<Host>>(Ctor: HostBoundFeatureCtor<T, Host>, ...args: unknown[]): T
	use<T extends BaseFeature>(
		Ctor: FeatureCtor<T> | HostBoundFeatureCtor<T, Host>,
		...args: unknown[]
	): T {
		this.ensureActive('use')
		return this.useInternal(Ctor, args, { checkDeclaration: true })
	}

	tryUse<T extends BaseFeature>(spec: OptionalFeatureSpec<T, Host>): Promise<T | undefined> {
		this.ensureActive('tryUse')
		if (!isOptionalFeatureSpec(spec)) {
			throw new Error(
				'[pluxel/core] FeatureHost.tryUse() expects a spec created by defineOptionalFeature(). Keep optional feature declaration separate from runtime activation.',
			)
		}
		if (arguments.length > 1) {
			throw new Error(
				'[pluxel/core] FeatureHost.tryUse() does not accept feature constructor args. Move runtime input onto the optional feature spec, host plugin, or feature state.',
			)
		}
		const key = spec.key
		this.assertOptionalSpecConsistency(key, spec)
		const cached = this.optionalLoads.get(key)
		if (cached) return cached as Promise<T | undefined>
		const epoch = this.disposeEpoch

		const task = this.tryUseInternal(spec, key)
			.then((feature) => {
				if (this.disposed || this.disposeEpoch !== epoch) {
					this.clearOptionalKey(key)
					return undefined
				}
				if (!feature) {
					this.clearOptionalKey(key)
					return undefined
				}
				const settled = Promise.resolve(feature as BaseFeature | undefined)
				this.optionalLoads.set(key, settled)
				return feature as T
			})
			.catch((error) => {
				this.clearOptionalKey(key)
				throw error
			})

		this.optionalLoads.set(key, task as Promise<BaseFeature | undefined>)
		return task
	}

	/** @internal Called by the registry after config validation/injection. */
	[FEATURE_CONFIG_INJECTOR](): void {
		if (this.instances.size === 0) return
		for (const feature of this.instances.values()) this.tryInjectConfigsIntoFeature(feature)
	}

	private tryInjectConfigsIntoFeature(instance: BaseFeature): void {
		try {
			callFeatureConfigInjector(instance)
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
		watcher.cbs.set(cbAny, undefined)

		const hadSub = Boolean(watcher.unsub)
		if (!hadSub) {
			const registry = this.getRegistry()
			if (!registry || typeof registry.watchInstance !== 'function') {
				throw new Error('[pluxel/core] FeatureHost.dep requires PluginService.watchInstance')
			}
			watcher.unsub = registry.watchInstance(id, (instance) =>
				this.flushDepWatcherRaw(watcher, instance),
			)
		} else if (watcher.lastRaw !== undefined) {
			const view = this.withCaller(watcher.lastRaw as InstanceType<PluginIdentifier>)
			this.invokeDepCb(watcher, cbAny, view)
		}

		let active = true
		const off = () => {
			if (!active) return
			active = false
			const current = this.depWatchers.get(id)

			const live = current ?? watcher
			const cleanup = live.cbs.get(cbAny)
			if (cleanup) {
				try {
					cleanup()
				} catch (error) {
					this.ctx.logger.error('feature dep cleanup error', { error })
				}
			}

			if (!current) return
			current.cbs.delete(cbAny)
			if (current.cbs.size > 0) return
			if (current.unsub) {
				try {
					current.unsub()
				} catch {
					// ignore
				}
			}
			this.depWatchers.delete(id)
		}

		// Auto-collect: plugin authors usually don't want to track unsubs manually.
		this.ctx.effects.defer(off)

		return off
	}

	get<T extends BaseFeature>(Ctor: FeatureCtor<T>): T | undefined {
		return this.instances.get(Ctor) as T | undefined
	}

	dispose<T extends BaseFeature>(Ctor: FeatureCtor<T>): void {
		const existing = this.instances.get(Ctor)
		if (!existing) return
		this.instances.delete(Ctor)
		this.clearOptionalCtor(Ctor as unknown as FeatureCtor<BaseFeature>)
		existing.dispose()
	}

	disposeAll(): void {
		this.disposed = true
		this.disposeEpoch++
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
		this.optionalLoads.clear()
		this.optionalCtors.clear()
		this.optionalSpecs.clear()

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

	private useInternal<T extends BaseFeature>(
		Ctor: FeatureUseCtor<T, Host>,
		args: unknown[],
		opts: { checkDeclaration: boolean },
	): T {
		const key = Ctor as unknown as FeatureCtor<BaseFeature>
		const existing = this.instances.get(key)
		if (existing) return existing as T
		if (opts.checkDeclaration) this.warnIfUndeclared(key)

		const finalArgs =
			this.ownerInstance && isHostBoundFeature(Ctor) ? [this.ownerInstance, ...args] : args
		const AnyCtor = Ctor as unknown as new (ctx: Context, ...args: unknown[]) => T
		const instance = new AnyCtor(this.ctx, ...finalArgs)
		this.tryInjectConfigsIntoFeature(instance)
		this.instances.set(key, instance)
		return instance
	}

	private async tryUseInternal<T extends BaseFeature>(
		spec: OptionalFeatureSpec<T, Host>,
		key: string,
	): Promise<T | undefined> {
		if (!(await this.canActivateOptional(spec))) return undefined
		if (this.disposed) return undefined

		try {
			const loaded = spec.load()
			if (!isPromiseLike<FeatureUseCtor<T, Host>>(loaded)) {
				throw new TypeError(
					'[pluxel/core] Optional feature load must return a Promise. Use dynamic import(...) to keep optional features off the host static path.',
				)
			}
			const Ctor = await loaded
			if (this.disposed) return undefined
			this.assertOptionalFeatureCtor(Ctor, key)
			this.optionalCtors.set(key, Ctor as unknown as FeatureCtor<BaseFeature>)
			const instance = this.useInternal(Ctor, [], { checkDeclaration: false })
			this.assertOptionalFeatureInstance(instance, key)
			return instance
		} catch (error) {
			this.ctx.logger.warn('optional feature skipped', { key, error })
			return undefined
		}
	}

	private async canActivateOptional<T extends BaseFeature>(
		spec: OptionalFeatureSpec<T, Host>,
	): Promise<boolean> {
		const requires = spec.requires
		if (requires?.length) {
			const registry = this.getRegistry()
			for (let i = 0; i < requires.length; i++) {
				const dep = requires[i]!
				if (registry?.isRegistered?.(dep)) continue
				if (!this.getRawDep(dep)) return false
			}
		}

		const when = spec.when
		if (when === undefined) return true
		if (typeof when !== 'function') return Boolean(when)
		return Boolean(await when(this.ctx))
	}

	private assertOptionalFeatureCtor<T extends BaseFeature>(
		Ctor: FeatureUseCtor<T, Host>,
		key: string,
	): void {
		const ctor = Ctor as unknown as AnyCtor
		const hasConfig = getDeclaredConfigKeys(ctor).length > 0
		const hasDeps = getRequiredPluginDependencies(ctor, { inherit: true }).length > 0
		if (!hasConfig && !hasDeps) return

		const label = (ctor as { name?: string }).name ?? '<anonymous>'
		const reasons: string[] = []
		if (hasConfig) reasons.push('declares feature config')
		if (hasDeps) reasons.push('declares required plugin deps')
		throw new Error(
			`Optional feature "${key}" cannot use ${label}: ${reasons.join(
				' and ',
			)}. Use \`use()\` for declaration-time features, or move gates/deps onto the \`tryUse()\` spec.`,
		)
	}

	private assertOptionalFeatureInstance(instance: BaseFeature, key: string): void {
		const record = instance as unknown as Record<string, unknown>
		const ownKeys = Object.keys(record)
		for (let i = 0; i < ownKeys.length; i++) {
			const field = ownKeys[i]!
			if (!isConfigSentinel(record[field])) continue
			this.dispose(instance.constructor as FeatureCtor<BaseFeature>)
			throw new Error(
				`Optional feature "${key}" cannot expose configs.use(...) fields at runtime. Move gate config onto the host plugin, or register this feature through \`use()\`.`,
			)
		}
	}

	private assertOptionalSpecConsistency<T extends BaseFeature>(
		key: string,
		spec: OptionalFeatureSpec<T, Host>,
	): void {
		const prev = this.optionalSpecs.get(key)
		if (!prev) {
			this.optionalSpecs.set(key, spec as unknown as OptionalFeatureSpec<BaseFeature, Host>)
			return
		}
		if (prev === spec) return
		throw new Error(
			`Optional feature key "${key}" was reused with a different spec. Reuse one stable defineOptionalFeature(...) result per key.`,
		)
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
		try {
			const cleanup = cb(depView)
			watcher.cbs.set(cb, typeof cleanup === 'function' ? (cleanup as () => void) : undefined)
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
		const registry = this.getRegistry()
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
		this.depCtxDesc.value = view
		const wrapped = Object.create(raw as object, { ctx: this.depCtxDesc }) as InstanceType<T>
		this.depCtxDesc.value = null

		if (raw && (typeof raw === 'object' || typeof raw === 'function')) {
			this.depViewCache.set(raw as unknown as object, wrapped)
		}

		return wrapped
	}

	private disposeWatcherCbs(watcher: DepWatcher): void {
		for (const [cb, cleanup] of watcher.cbs) {
			if (!cleanup) continue
			try {
				cleanup()
			} catch (error) {
				this.ctx.logger.error('feature dep cleanup error', { error })
			} finally {
				watcher.cbs.set(cb, undefined)
			}
		}
	}

	private clearOptionalCtor(Ctor: FeatureCtor<BaseFeature>): void {
		for (const [key, current] of this.optionalCtors) {
			if (current !== Ctor) continue
			this.clearOptionalKey(key)
		}
	}

	private clearOptionalKey(key: string): void {
		this.optionalLoads.delete(key)
		this.optionalCtors.delete(key)
		this.optionalSpecs.delete(key)
	}

	private ensureActive(op: 'use' | 'tryUse'): void {
		if (!this.disposed) return
		throw new Error(`[pluxel/core] FeatureHost.${op}() called after host disposal`)
	}
}

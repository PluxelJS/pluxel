import type { Context } from '@pluxel/context'
import type { BaseFeature, FeatureCtor } from './BaseFeature'
import { getDeclaredConfigKeys, getRequiredPluginDependencies, getUsedFeatures } from './internal/decorator/api'
import { __DEV__ } from './internal/decorator/shared'

const FEATURE_DECLARATION_POLICY = Symbol.for('pluxel:feature:declarationPolicy')
type FeatureDeclarationPolicy = 'off' | 'warn' | 'error'

export class FeatureHost {
	private readonly instances = new Map<FeatureCtor<any>, BaseFeature<any>>()
	private readonly warned = new Set<FeatureCtor<any>>()

	constructor(
		public readonly ctx: Context,
		private readonly ownerCtor?: Function,
	) {
		// Ensure all features are disposed with the owning plugin scope.
		this.ctx.collectEffect(() => this.disposeAll())
	}

	use<T extends BaseFeature<any>>(Ctor: FeatureCtor<T>, ...args: any[]): T {
		const existing = this.instances.get(Ctor)
		if (existing) return existing as T

		this.warnIfUndeclared(Ctor)

		const instance = new Ctor(this.ctx, ...args)
		try {
			const maybe = instance as unknown as { __injectConfigsFromHostPlugin?: () => void }
			if (typeof maybe.__injectConfigsFromHostPlugin === 'function') {
				maybe.__injectConfigsFromHostPlugin()
			}
		} catch (error) {
			this.ctx.logger.error('feature config inject error', { error })
		}
		this.instances.set(Ctor, instance)
		return instance
	}

	get<T extends BaseFeature<any>>(Ctor: FeatureCtor<T>): T | undefined {
		return this.instances.get(Ctor) as T | undefined
	}

	dispose<T extends BaseFeature<any>>(Ctor: FeatureCtor<T>): void {
		const existing = this.instances.get(Ctor)
		if (!existing) return
		this.instances.delete(Ctor)
		existing.dispose()
	}

	disposeAll(): void {
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

	private warnIfUndeclared<T extends BaseFeature<any>>(Ctor: FeatureCtor<T>): void {
		const policy =
			((this.ctx as any)?.[FEATURE_DECLARATION_POLICY] as FeatureDeclarationPolicy | undefined) ??
			(__DEV__ ? 'warn' : 'off')
		if (policy === 'off') return

		// If we don't know the owning plugin ctor, we can't validate declaration-time metadata.
		if (!this.ownerCtor) return
		if (this.warned.has(Ctor)) return

		// If this feature does not declare config fields or decorator-required deps,
		// it can be purely runtime-composed without any declaration-time metadata.
		const hasConfig = getDeclaredConfigKeys(Ctor as any).length > 0
		const hasDeps = getRequiredPluginDependencies(Ctor as any, { inherit: true }).length > 0
		if (!hasConfig && !hasDeps) return

		const declared = getUsedFeatures(this.ownerCtor)
		if (declared.includes(Ctor as any)) return

		this.warned.add(Ctor)

		const payload = {
			ownerId: (this.ctx as any)?.pluginInfo?.id,
			ownerCtor: (this.ownerCtor as any)?.name ?? '<unknown>',
			feature: (Ctor as any)?.name ?? '<anonymous>',
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
}

import type { Buildable, ServiceData } from '../internal-types'
import { RegistrationType, ScopeType } from '../types'
import type {
	BuildOptions,
	Identifier,
	Newable,
	WithDependencies,
	WithScopeChange,
} from '../types/types'
import { getDependencies } from '../utils/reflection'
import { ServiceConfiguration } from './service-configuration'

export class ClassConfiguration<T>
	extends ServiceConfiguration<T>
	implements WithScopeChange, WithDependencies
{
	protected scope = ScopeType.Transient
	private dependencies: Identifier<unknown>[] = []
	/** 是否允许自动注入（局部开关，默认 true）。会与 BuildOptions.autowire 取交集得到“实际值”。 */
	private autowire = true

	private constructor(
		private readonly newable: Newable<T>,
		onMutate?: () => void,
	) {
		super(onMutate)
	}

	public withDependencies(dependencies: Identifier<unknown>[]): this {
		this.dependencies = dependencies.slice()
		this.autowire = false
		this.onMutate?.()
		return this
	}

	public asTransient(): this {
		return super.asTransient()
	}
	public asSingleton(): this {
		return super.asSingleton()
	}
	public asInstancePerRequest(): this {
		return super.asInstancePerRequest()
	}
	public asBuilderSingleton(): this {
		return super.asBuilderSingleton()
	}

	/** 根据“实际生效的 autowire”填充依赖信息（无异常流控）。 */
	private setDependencyInformationIfNotExist(effectiveAutowire: boolean): void {
		if (effectiveAutowire) {
			// 可能抛 UndecoratedServiceError，由 builder 捕获并折叠为 InvalidRegistration
			this.dependencies = getDependencies(this.newable)
			return
		}
		// 非 autowire：不在这里做显式依赖数校验，交由 verifier 统一处理
	}

	protected build(options: BuildOptions): ServiceData<T> {
		const effectiveAutowire = !!(options.autowire && this.autowire)
		this.setDependencyInformationIfNotExist(effectiveAutowire)

		const tags = this.tags.length ? this.tags.slice() : []
		const aliases = this.alias.length ? this.alias.slice() : []
		const dependencies = this.dependencies.length ? this.dependencies.slice() : []

		return {
			tags,
			aliases,
			isPrivate: this.isPrivate,
			scope: this.scope,
			type: RegistrationType.Class,
			class: this.newable,
			dependencies,
			// 写入“实际生效”的 autowire，供 verifier 做一致性判断
			autowire: effectiveAutowire,
		}
	}

	public static createBuildable<TIdentifier>(
		newable: Newable<TIdentifier>,
		onMutate?: () => void,
	): Buildable<ClassConfiguration<TIdentifier>, TIdentifier> {
		const use = new ClassConfiguration(newable, onMutate)
		return {
			instance: use,
			build: (options: BuildOptions): ServiceData<TIdentifier> => use.build(options),
		}
	}
}

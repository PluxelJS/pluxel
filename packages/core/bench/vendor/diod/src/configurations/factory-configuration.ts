import type { Buildable, ServiceData } from '../internal-types'
import { RegistrationType, ScopeType } from '../types'
import type { Factory, Identifier, WithDependencies, WithScopeChange } from '../types/types'
import { ServiceConfiguration } from './service-configuration'

export class FactoryConfiguration<T>
	extends ServiceConfiguration<T>
	implements WithScopeChange, WithDependencies
{
	protected scope = ScopeType.Transient
	private dependencies: Identifier<unknown>[] = []

	private constructor(
		private readonly factory: Factory<T>,
		onMutate?: () => void,
	) {
		super(onMutate)
	}

	public withDependencies(dependencies: Identifier<unknown>[]): this {
		this.dependencies = [...dependencies]
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

	protected build(): ServiceData<T> {
		const tags = this.tags.length > 0 ? [...this.tags] : []
		const aliases = this.alias.length > 0 ? [...this.alias] : []
		const dependencies = this.dependencies.length > 0 ? [...this.dependencies] : []

		return {
			tags,
			aliases,
			isPrivate: this.isPrivate,
			scope: this.scope,
			type: RegistrationType.Factory,
			factory: this.factory,
			dependencies,
		}
	}

	public static createBuildable<TIdentifier>(
		factory: Factory<TIdentifier>,
		onMutate?: () => void,
	): Buildable<FactoryConfiguration<TIdentifier>, TIdentifier> {
		const use = new FactoryConfiguration(factory, onMutate)
		return {
			instance: use,
			build: (): ServiceData<TIdentifier> => use.build(),
		}
	}
}

import type { Buildable, ServiceData } from '../internal-types'
import { RegistrationType, ScopeType } from '../types'
import type { Factory, Identifier, WithScopeChange } from '../types/types'
import { ServiceConfiguration } from './service-configuration'

export class FactoryConfiguration<T>
	extends ServiceConfiguration<T>
	implements WithScopeChange
{
	protected scope = ScopeType.Transient
	private dependencies: Identifier<unknown>[] = []

	private constructor(private readonly factory: Factory<T>) {
		super()
	}

	public withDependencies(dependencies: Identifier<unknown>[]): this {
		this.dependencies = dependencies
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
		return {
			tags: this.tags,
			aliases: this.alias,
			isPrivate: this.isPrivate,
			scope: this.scope,
			type: RegistrationType.Factory,
			factory: this.factory,
			dependencies: this.dependencies,
		}
	}

	public static createBuildable<TIdentifier>(
		factory: Factory<TIdentifier>,
	): Buildable<FactoryConfiguration<TIdentifier>, TIdentifier> {
		const use = new FactoryConfiguration(factory)
		return {
			instance: use,
			build: (): ServiceData<TIdentifier> => use.build(),
		}
	}
}

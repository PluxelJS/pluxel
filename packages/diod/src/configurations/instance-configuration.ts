import type { Buildable, ServiceData } from '../internal-types'
import { RegistrationType, ScopeType } from '../types'
import type { Instance } from '../types/types'
import { ServiceConfiguration } from './service-configuration'

export class InstanceConfiguration<T> extends ServiceConfiguration<T> {
	protected readonly scope = ScopeType.Singleton

	private constructor(
		private readonly instance: Instance<T>,
		onMutate?: () => void,
	) {
		super(onMutate)
	}

	protected build(): ServiceData<T> {
		const tags = this.tags.length ? this.tags.slice() : []
		const aliases = this.alias.length ? this.alias.slice() : []

		return {
			tags,
			aliases,
			isPrivate: this.isPrivate,
			scope: this.scope,
			type: RegistrationType.Instance,
			instance: this.instance,
			dependencies: [],
		}
	}

	public static createBuildable<TIdentifier>(
		instance: Instance<TIdentifier>,
		onMutate?: () => void,
	): Buildable<InstanceConfiguration<TIdentifier>, TIdentifier> {
		const use = new InstanceConfiguration(instance, onMutate)
		return {
			instance: use,
			build: (): ServiceData<TIdentifier> => use.build(),
		}
	}
}

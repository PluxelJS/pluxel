// registration.ts
// Simplicity first: any configuration pivot (.use*, factory/class/instance)
// will notify Builder via onMutate() to invalidate caches.
//
// 如果你在配置链（如 .asSingleton() / .addTag() / .addAlias()）实现里也调用 onMutate，
// 则 buildServices 的缓存将始终与配置一致（推荐这样做）。

import { ClassConfiguration } from './configurations/class-configuration'
import { FactoryConfiguration } from './configurations/factory-configuration'
import { InstanceConfiguration } from './configurations/instance-configuration'
import type { ServiceConfiguration } from './configurations/service-configuration'
import type { Buildable, ServiceData } from './internal-types'
import type {
	BuildOptions,
	ConfigurableRegistration,
	Factory,
	Identifier,
	Instance,
	Newable,
	Registration,
	WithDependencies,
	WithScopeChange,
} from './types/types'

type MutateCb = (id: Identifier<unknown>) => void

export class DiodRegistration<T> implements Registration<T> {
	private buildable: Buildable<ServiceConfiguration<T>, T> | undefined
	private readonly onMutate?: MutateCb

	private constructor(
		public readonly identifier: Identifier<T>,
		onMutate?: MutateCb,
	) {
		this.onMutate = onMutate
	}

	public useClass(
		newable: Newable<T>,
	): ConfigurableRegistration & WithScopeChange & WithDependencies {
		const buildable = ClassConfiguration.createBuildable(newable, () =>
			this.onMutate?.(this.identifier as Identifier<unknown>),
		)
		this.buildable = buildable
		this.onMutate?.(this.identifier as Identifier<unknown>)
		return buildable.instance
	}

	/** alias of useClass */
	public use(
		newable: Newable<T>,
	): ConfigurableRegistration & WithScopeChange & WithDependencies {
		return this.useClass(newable)
	}

	public useInstance(instance: Instance<T>): ConfigurableRegistration {
		const buildable = InstanceConfiguration.createBuildable(instance, () =>
			this.onMutate?.(this.identifier as Identifier<unknown>),
		)
		this.buildable = buildable
		this.onMutate?.(this.identifier as Identifier<unknown>)
		return buildable.instance
	}

	public useFactory(
		factory: Factory<T>,
	): ConfigurableRegistration & WithScopeChange & WithDependencies {
		const buildable = FactoryConfiguration.createBuildable(factory, () =>
			this.onMutate?.(this.identifier as Identifier<unknown>),
		)
		this.buildable = buildable
		this.onMutate?.(this.identifier as Identifier<unknown>)
		return buildable.instance
	}

	private build(options: BuildOptions): ServiceData<T> {
		if (this.buildable === undefined) {
			throw new Error(
				`Service ${this.identifier.name} registration is not completed. 
					Use .registerAndUse(${this.identifier.name}) instead of .register(${this.identifier.name}) 
					to use it directly or set any other registration use.`,
			)
		}
		return this.buildable.build(options)
	}

	public static createBuildable<TIdentifier>(
		identifier: Identifier<TIdentifier>,
		onMutate?: MutateCb,
	): Buildable<Registration<TIdentifier>, TIdentifier> {
		const registration = new DiodRegistration(identifier, onMutate)
		return {
			instance: registration,
			build: (options: BuildOptions): ServiceData<TIdentifier> =>
				registration.build(options),
		}
	}
}

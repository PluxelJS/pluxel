// internal-types.ts
import type { CheckRegistrationType, CheckScopeType, ScopeType } from './types'
import type {
	AliasKey,
	BuildOptions,
	Factory,
	Identifier,
	Instance,
	Newable,
} from './types/types'

type ConfigurationServiceData = {
	isPrivate: boolean
	tags: readonly string[]
	aliases: readonly AliasKey[]
}

export type ClassServiceData<T> = {
	scope: ScopeType
	class: Newable<T>
	autowire: boolean
	type: CheckRegistrationType<'class'>
	dependencies: readonly Identifier<unknown>[]
} & ConfigurationServiceData

export type FactoryServiceData<T> = {
	scope: ScopeType
	factory: Factory<T>
	dependencies: readonly Identifier<unknown>[]
	type: CheckRegistrationType<'factory'>
} & ConfigurationServiceData

export type InstanceServiceData<T> = {
	scope: CheckScopeType<'singleton'>
	instance: Instance<T>
	type: CheckRegistrationType<'instance'>
	dependencies: readonly []
} & ConfigurationServiceData

export type ServiceData<T> =
	| ClassServiceData<T>
	| FactoryServiceData<T>
	| InstanceServiceData<T>

export type ServiceListMetadata = Map<Identifier<unknown>, ServiceData<unknown>>

export type Buildable<C, T> = {
	instance: C
	build: (options: BuildOptions) => ServiceData<T>
}

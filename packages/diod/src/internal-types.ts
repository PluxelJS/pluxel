// internal-types.ts
import type { CheckRegistrationType, CheckScopeType, ScopeType } from './types'
import type {
	Abstract,
	AliasKey,
	BuildOptions,
	Factory,
	Instance,
	Newable,
} from './types/types'

type ConfigurationServiceData = {
	isPrivate: boolean
	tags: string[]
	aliases: AliasKey[]
}

export type ClassServiceData<T> = {
	scope: ScopeType
	class: Newable<T>
	autowire: boolean
	type: CheckRegistrationType<'class'>
	dependencies: Abstract<unknown>[]
} & ConfigurationServiceData

export type FactoryServiceData<T> = {
	scope: ScopeType
	factory: Factory<T>
	dependencies: Abstract<unknown>[]
	type: CheckRegistrationType<'factory'>
} & ConfigurationServiceData

export type InstanceServiceData<T> = {
	scope: CheckScopeType<'singleton'>
	instance: Instance<T>
	type: CheckRegistrationType<'instance'>
	dependencies: never[]
} & ConfigurationServiceData

export type ServiceData<T> =
	| ClassServiceData<T>
	| FactoryServiceData<T>
	| InstanceServiceData<T>

export type ServiceListMetadata = Map<Abstract<unknown>, ServiceData<unknown>>

export type Buildable<C, T> = {
	instance: C
	build: (options: BuildOptions) => ServiceData<T>
}

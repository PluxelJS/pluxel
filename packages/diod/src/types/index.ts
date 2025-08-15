export const RegistrationType = {
	Class: 'class',
	Factory: 'factory',
	Instance: 'instance',
} as const
export type RegistrationType =
	(typeof RegistrationType)[keyof typeof RegistrationType]
export type CheckRegistrationType<T extends RegistrationType> = T

export const ScopeType = {
	Transient: 'transient',
	Request: 'request',
	Singleton: 'singleton',
	Builder_Singleton: 'builder_singleton',
} as const
export type ScopeType = (typeof ScopeType)[keyof typeof ScopeType]
export type CheckScopeType<T extends ScopeType> = T

export * from './types'

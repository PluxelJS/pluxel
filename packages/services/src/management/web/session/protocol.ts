import type { RpcTarget } from 'capnweb'
import type { ManagementAuthenticationProviderStep } from '../../services/admin-access/types'
import type { RuntimeManagementTarget } from '../management-target'

export const RUNTIME_SESSION_PROFILE = 2 as const
export const RUNTIME_SESSION_PATH = '/__pluxel/runtime/session' as const

export type RuntimeSessionInvalidationCause = 'authentication' | 'service-restart' | 'workbench'

export type RuntimeSessionEvent = Readonly<{
	kind: 'epoch-invalidated'
	cause: RuntimeSessionInvalidationCause
}>

export type RuntimeSessionObserver = (event: RuntimeSessionEvent) => void | Promise<void>

export type RuntimeLogoutResult =
	| Readonly<{ kind: 'closed' }>
	| Readonly<{
			kind: 'cookie-commit-required'
			ticket: string
			expiresAt: number
	  }>

export interface RuntimeAuthenticationTarget extends RpcTarget {
	stateDto(): ManagementAuthenticationProviderStep | Promise<ManagementAuthenticationProviderStep>
	submitDto(
		input: unknown,
	): ManagementAuthenticationProviderStep | Promise<ManagementAuthenticationProviderStep>
}

export type RuntimeBootstrap<TWorkbench extends RpcTarget = RpcTarget> =
	| Readonly<{
			kind: 'authentication-required'
			profile: 2
			authentication: RuntimeAuthenticationTarget
	  }>
	| Readonly<{
			kind: 'management'
			profile: 2
			management: RuntimeManagementTarget
	  }>
	| Readonly<{
			kind: 'workbench'
			profile: 2
			management: RuntimeManagementTarget
			workbench: TWorkbench
	  }>

export interface RuntimeSessionRoot<TWorkbench extends RpcTarget = RpcTarget> extends RpcTarget {
	bootstrap(
		observer: RuntimeSessionObserver,
	): RuntimeBootstrap<TWorkbench> | Promise<RuntimeBootstrap<TWorkbench>>
	logoutDto(): RuntimeLogoutResult | Promise<RuntimeLogoutResult>
}

export type { RuntimeManagementTarget } from '../management-target'

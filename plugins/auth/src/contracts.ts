import type {
	ManagementAccessMethod,
	ManagementAccessPrincipal,
	ManagementAccessProvider,
	ManagementAccessProviderDecision,
	ManagementAccessProviderStatus,
	ManagementAccessRequestContext,
} from '@pluxel/runtime'

export type AuthMethod = ManagementAccessMethod
export type AuthPrincipal = ManagementAccessPrincipal
export type AuthDecision = ManagementAccessProviderDecision
export type AuthProviderStatus = ManagementAccessProviderStatus
export type AuthRequestContext = ManagementAccessRequestContext
export type ManagementAuthProvider = ManagementAccessProvider

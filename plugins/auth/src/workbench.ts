import type { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'

export type AuthSetupMode = 'password' | 'password-totp' | 'oidc-public' | 'oidc-confidential'

export type AuthCredentialSetupMode = Exclude<AuthSetupMode, 'oidc-public'>

export type AuthSetupSnapshot =
	| Readonly<{ mode: AuthSetupMode; state: 'configured' }>
	| Readonly<{
			mode: AuthCredentialSetupMode
			state: 'setup-required'
			reason: 'missing' | 'invalid'
	  }>
	| Readonly<{
			mode: AuthCredentialSetupMode
			state: 'unavailable'
			reason: 'vault-unavailable'
	  }>

export type AuthSetupFailureCode =
	| 'forbidden'
	| 'not_required'
	| 'unavailable'
	| 'invalid_input'
	| 'busy'
	| 'enrollment_expired'
	| 'verification_failed'
	| 'storage_failed'

export type AuthSetupFailure = Readonly<{
	ok: false
	code: AuthSetupFailureCode
	message: string
}>

export type AuthSetupMutationResult =
	| Readonly<{ ok: true; snapshot: AuthSetupSnapshot }>
	| AuthSetupFailure

export type AuthPasswordSetupInput = Readonly<{
	username: string
	password: string
	passwordConfirmation: string
}>

export type AuthTotpConfirmationInput = Readonly<{
	enrollmentId: string
	code: string
}>

export type AuthOidcSecretSetupInput = Readonly<{
	secret: string
}>

export type AuthTotpEnrollment = Readonly<{
	id: string
	secret: string
	provisioningUri: string
	expiresAt: number
}>

export type AuthTotpEnrollmentResult =
	| Readonly<{ ok: true; enrollment: AuthTotpEnrollment }>
	| AuthSetupFailure

export interface AuthSetupApi extends RpcTarget {
	snapshot(): AuthSetupSnapshot
	setupPassword(input: AuthPasswordSetupInput): Promise<AuthSetupMutationResult>
	beginTotp(input: AuthPasswordSetupInput): Promise<AuthTotpEnrollmentResult>
	confirmTotp(input: AuthTotpConfirmationInput): Promise<AuthSetupMutationResult>
	setupOidcSecret(input: AuthOidcSecretSetupInput): Promise<AuthSetupMutationResult>
}

export const AuthWorkbench = workbench.define({
	setup: workbench.view<AuthSetupApi>({
		renderer: workbench.entry(import.meta.url, './ui/setup.tsx'),
		placement: workbench.route('/auth/setup', {
			title: 'Authentication setup',
			icon: workbench.icons.ShieldLock,
			navigation: { label: 'Authentication' },
			order: 10,
		}),
	}),
})

import { workbench } from '@pluxel/workbench'
import type { AuthSetupApi } from './workbench-contracts.ts'

export type {
	AuthCredentialSetupMode,
	AuthOidcSecretSetupInput,
	AuthPasswordSetupInput,
	AuthSetupApi,
	AuthSetupFailure,
	AuthSetupFailureCode,
	AuthSetupMode,
	AuthSetupMutationResult,
	AuthSetupSnapshot,
	AuthTotpConfirmationInput,
	AuthTotpEnrollment,
	AuthTotpEnrollmentResult,
} from './workbench-contracts.ts'

export const AuthWorkbench = workbench.define(import.meta.url, {
	setup: workbench.view<AuthSetupApi>({
		renderer: './ui/setup.tsx',
		placement: {
			kind: 'route',
			path: '/auth/setup',
			title: 'Authentication setup',
			icon: 'shield-lock',
			navigation: { label: 'Authentication' },
			order: 10,
		},
	}),
})

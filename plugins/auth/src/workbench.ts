import { workbench } from '@pluxel/runtime/workbench'
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

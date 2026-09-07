import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { AuthWorkbench } from '../workbench.ts'
import type {
	AuthOidcSecretSetupInput,
	AuthPasswordSetupInput,
	AuthTotpConfirmationInput,
} from '../workbench-contracts.ts'

export const setupScope = createWorkbenchRenderer(AuthWorkbench.setup)

export const authSetupSnapshotQuery = setupScope.query(({ api }) => ({
	queryKey: ['auth', 'setup', 'snapshot'] as const,
	queryFn: () => api.snapshot(),
}))

export const setupPasswordMutation = setupScope.mutation(({ api }) => ({
	mutationFn: (input: AuthPasswordSetupInput) => api.setupPassword(input),
	workbench: {
		invalidates: [authSetupSnapshotQuery],
	},
}))

export const beginTotpMutation = setupScope.mutation(({ api }) => ({
	mutationFn: (input: AuthPasswordSetupInput) => api.beginTotp(input),
}))

export const confirmTotpMutation = setupScope.mutation(({ api }) => ({
	mutationFn: (input: AuthTotpConfirmationInput) => api.confirmTotp(input),
	workbench: {
		invalidates: [authSetupSnapshotQuery],
	},
}))

export const setupOidcSecretMutation = setupScope.mutation(({ api }) => ({
	mutationFn: (input: AuthOidcSecretSetupInput) => api.setupOidcSecret(input),
	workbench: {
		invalidates: [authSetupSnapshotQuery],
	},
}))

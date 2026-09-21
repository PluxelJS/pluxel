import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { AuthWorkbench } from '../workbench.ts'
import type {
	AuthOidcSecretSetupInput,
	AuthPasswordSetupInput,
	AuthTotpConfirmationInput,
} from '../workbench-contracts.ts'

export const setupScope = createWorkbenchRenderer(AuthWorkbench.setup)

export const authSetupSnapshotQuery = setupScope.query(({ api }) => ({
	queryKey: ['auth', 'setup', 'snapshot'] as const,
	queryFn: () => api.snapshotDto(),
}))

export const setupPasswordMutation = setupScope.mutation(({ api }) => ({
	mutationFn: (input: AuthPasswordSetupInput) => api.setupPasswordDto(input),
	workbench: {
		invalidates: [authSetupSnapshotQuery],
	},
}))

export const beginTotpMutation = setupScope.mutation(({ api }) => ({
	mutationFn: (input: AuthPasswordSetupInput) => api.beginTotpDto(input),
}))

export const confirmTotpMutation = setupScope.mutation(({ api }) => ({
	mutationFn: (input: AuthTotpConfirmationInput) => api.confirmTotpDto(input),
	workbench: {
		invalidates: [authSetupSnapshotQuery],
	},
}))

export const setupOidcSecretMutation = setupScope.mutation(({ api }) => ({
	mutationFn: (input: AuthOidcSecretSetupInput) => api.setupOidcSecretDto(input),
	workbench: {
		invalidates: [authSetupSnapshotQuery],
	},
}))

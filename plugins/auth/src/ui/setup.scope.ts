import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { AuthWorkbench } from '../workbench.ts'
import type {
	AuthOidcSecretSetupInput,
	AuthPasswordSetupInput,
	AuthTotpConfirmationInput,
} from '../workbench-contracts.ts'

export const setupScope = createWorkbenchRenderer(AuthWorkbench.setup)

export const authSetupSnapshotQuery = setupScope.query({
	queryFn: ({ api }) => api.snapshot(),
})

export const setupPasswordMutation = setupScope.mutation({
	mutationFn: ({ api }, input: AuthPasswordSetupInput) => api.setupPassword(input),
	invalidates: [authSetupSnapshotQuery],
})

export const beginTotpMutation = setupScope.mutation({
	mutationFn: ({ api }, input: AuthPasswordSetupInput) => api.beginTotp(input),
})

export const confirmTotpMutation = setupScope.mutation({
	mutationFn: ({ api }, input: AuthTotpConfirmationInput) => api.confirmTotp(input),
	invalidates: [authSetupSnapshotQuery],
})

export const setupOidcSecretMutation = setupScope.mutation({
	mutationFn: ({ api }, input: AuthOidcSecretSetupInput) => api.setupOidcSecret(input),
	invalidates: [authSetupSnapshotQuery],
})

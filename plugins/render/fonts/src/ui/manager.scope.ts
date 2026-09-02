import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import type { InstallManagedFontInput } from '../workbench-contracts.ts'
import { FontsWorkbench } from '../workbench.ts'

export const managerScope = createWorkbenchRenderer(FontsWorkbench.manager)

export const fontManagerSnapshotQuery = managerScope.query({
	queryFn: ({ api }) => api.snapshot(),
})

export const setPreferredFontMutation = managerScope.mutation({
	mutationFn: ({ api }, family: string | null) => api.setPreferredFamily(family),
	invalidates: [fontManagerSnapshotQuery],
})

export const installManagedFontMutation = managerScope.mutation({
	mutationFn: ({ api }, input: InstallManagedFontInput) => api.install(input),
	invalidates: [fontManagerSnapshotQuery],
})

export const removeManagedFontMutation = managerScope.mutation({
	mutationFn: ({ api }, id: string) => api.remove(id),
	invalidates: [fontManagerSnapshotQuery],
})

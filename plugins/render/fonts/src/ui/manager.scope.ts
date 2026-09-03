import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import type { InstallManagedFontInput } from '../workbench-contracts.ts'
import { FontsWorkbench } from '../workbench.ts'

export const managerScope = createWorkbenchRenderer(FontsWorkbench.manager)

export const fontManagerSnapshotQuery = managerScope.query(({ api }) => ({
	queryKey: ['fonts', 'manager', 'snapshot'] as const,
	queryFn: () => api.snapshot(),
}))

export const setPreferredFontMutation = managerScope.mutation(({ api }) => ({
	mutationFn: (family: string | null) => api.setPreferredFamily(family),
	workbench: {
		invalidates: [fontManagerSnapshotQuery],
	},
}))

export const installManagedFontMutation = managerScope.mutation(({ api }) => ({
	mutationFn: (input: InstallManagedFontInput) => api.install(input),
	workbench: {
		invalidates: [fontManagerSnapshotQuery],
	},
}))

export const removeManagedFontMutation = managerScope.mutation(({ api }) => ({
	mutationFn: (id: string) => api.remove(id),
	workbench: {
		invalidates: [fontManagerSnapshotQuery],
	},
}))

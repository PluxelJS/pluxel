import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { PackageManagerWorkbench } from '../workbench.ts'

export const managerScope = createWorkbenchRenderer(PackageManagerWorkbench.manager)

export const packageManagerSnapshotQuery = managerScope.query(({ api }) => ({
	queryKey: ['package-manager', 'snapshot'] as const,
	queryFn: () => api.snapshot(),
}))

export const installPackagesMutation = managerScope.mutation(({ api }) => ({
	mutationFn: (specs: readonly string[]) => api.install(specs),
	workbench: {
		invalidates: [packageManagerSnapshotQuery],
	},
}))

export const removePackagesMutation = managerScope.mutation(({ api }) => ({
	mutationFn: (names: readonly string[]) => api.remove(names),
	workbench: {
		invalidates: [packageManagerSnapshotQuery],
	},
}))

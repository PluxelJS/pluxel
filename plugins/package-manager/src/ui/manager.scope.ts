import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { PackageManagerWorkbench } from '../workbench.ts'

export const managerScope = createWorkbenchRenderer(PackageManagerWorkbench.manager)

export const packageManagerSnapshotQuery = managerScope.query({
	queryFn: ({ api }) => api.snapshot(),
})

export const installPackagesMutation = managerScope.mutation({
	mutationFn: ({ api }, specs: readonly string[]) => api.install(specs),
	invalidates: [packageManagerSnapshotQuery],
})

export const removePackagesMutation = managerScope.mutation({
	mutationFn: ({ api }, names: readonly string[]) => api.remove(names),
	invalidates: [packageManagerSnapshotQuery],
})

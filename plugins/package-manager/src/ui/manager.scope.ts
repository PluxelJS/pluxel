import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { PackageManagerWorkbench } from '../workbench.ts'
import { createPackageManagerResources } from './package-manager.resources.ts'

export const managerScope = createWorkbenchRenderer(PackageManagerWorkbench.manager)
export const managerResources = createPackageManagerResources(managerScope)

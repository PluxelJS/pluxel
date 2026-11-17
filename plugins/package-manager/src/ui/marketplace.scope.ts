import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { PackageManagerWorkbench } from '../workbench.ts'
import { createPackageManagerResources } from './package-manager.resources.ts'

export const marketplaceScope = createWorkbenchRenderer(PackageManagerWorkbench.marketplace)
export const marketplaceResources = createPackageManagerResources(marketplaceScope)

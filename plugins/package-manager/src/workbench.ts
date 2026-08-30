import { workbench } from '@pluxel/runtime/workbench'
import type { PackageManagerApi } from './contracts.ts'

export const PackageManagerWorkbench = workbench.define({
	manager: workbench.view<PackageManagerApi>({
		renderer: workbench.entry(import.meta.url, './ui/index.tsx'),
		placement: workbench.route('/packages', {
			title: 'Packages',
			icon: workbench.icons.CloudUpload,
			navigation: { label: 'Packages' },
			order: 80,
		}),
	}),
})

export type {
	ManagedPackage,
	PackageManagerApi,
	PackageManagerSnapshot,
	PackageMutationFailure,
	PackageMutationResult,
} from './contracts.ts'

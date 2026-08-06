import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import type { PackageManagerCommands } from './contracts.ts'

export const PackageManagerWorkbenchUi = workbenchContract.define({
	resources: {
		manager: workbenchContract.rpc<PackageManagerCommands>(),
	},
	views: {
		Manager: {
			placements: [
				workbenchContract.route('/packages', {
					title: 'Packages',
					icon: workbenchContract.icons.CloudUpload,
					navigation: true,
					order: 80,
				}),
			],
		},
	},
})

export type {
	ManagedPackage,
	PackageManagerCommands,
	PackageManagerSnapshot,
	PackageMutationFailure,
	PackageMutationResult,
} from './contracts.ts'

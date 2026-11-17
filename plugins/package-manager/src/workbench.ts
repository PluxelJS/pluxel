import { workbench } from '@pluxel/workbench'
import type { PackageManagerApi } from './contracts.ts'

export const PackageManagerWorkbench = workbench.define({
	marketplace: workbench.view<PackageManagerApi>({
		renderer: workbench.entry(import.meta.url, './ui/marketplace-page.tsx'),
		placement: workbench.route('/market', {
			title: 'Plugin marketplace',
			icon: workbench.icons.CloudUpload,
			navigation: { label: 'Marketplace' },
			order: 75,
		}),
	}),
	manager: workbench.view<PackageManagerApi>({
		renderer: workbench.entry(import.meta.url, './ui/manager.tsx'),
		placement: workbench.route('/packages', {
			title: 'Plugin packages',
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
	PackageMarket,
	PackageInstallPlan,
	PackagePreparationResult,
	MarketPackageQuery,
	MarketPackageSummary,
	MarketPackagePage,
	MarketPackageDetail,
	MarketRelease,
	MarketReleaseQuery,
	MarketReleasePage,
	MarketReadResult,
	MarketInstallRequest,
	PackageMutationFailure,
	PackageMutationResult,
} from './contracts.ts'

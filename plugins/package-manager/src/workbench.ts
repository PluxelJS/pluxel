import { workbench } from '@pluxel/workbench'
import type { PackageManagerApi } from './contracts.ts'

export const PackageManagerWorkbench = workbench.define(import.meta.url, {
	marketplace: workbench.view<PackageManagerApi>({
		renderer: './ui/marketplace-page.tsx',
		placement: {
			kind: 'route',
			path: '/market',
			title: 'Plugin marketplace',
			icon: 'cloud-upload',
			navigation: { label: 'Marketplace' },
			order: 75,
		},
	}),
	manager: workbench.view<PackageManagerApi>({
		renderer: './ui/manager.tsx',
		placement: {
			kind: 'route',
			path: '/packages',
			title: 'Plugin packages',
			icon: 'cloud-upload',
			navigation: { label: 'Packages' },
			order: 80,
		},
	}),
})

export type {
	RegistryCandidate,
	RegistrySearch,
	RegistryInspection,
	LocalPackageLocation,
	ManagedPackage,
	PackageManagerApi,
	PackageManagerSnapshot,
	PackageMarket,
	PackageInstallPlan,
	PackagePreparationResult,
	MarketCatalogFilters,
	MarketCatalogFacets,
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
export type { PackageDocument, LocalPackageDependency } from './package-document.ts'

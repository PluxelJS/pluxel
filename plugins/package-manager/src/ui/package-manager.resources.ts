import { readPackageUsage } from './package-usage.ts'
import type { WorkbenchRendererScope } from '@pluxel/workbench/react'
import type { PackageManagerWorkbench } from '../workbench.ts'
import type {
	LocalPackageLocation,
	MarketCatalogFilters,
	MarketInstallRequest,
	MarketPackageQuery,
	MarketReleaseQuery,
} from '../contracts.ts'

export type PrepareInstallInput =
	| Readonly<{ kind: 'direct'; specs: readonly string[] }>
	| Readonly<{ kind: 'market'; requests: readonly MarketInstallRequest[] }>

export function createPackageManagerResources(
	scope: WorkbenchRendererScope<typeof PackageManagerWorkbench.manager>,
) {
	const packageManagerSnapshotQuery = scope.query(({ api }) => ({
		queryKey: ['package-manager', 'snapshot'] as const,
		queryFn: () => api.snapshotDto(),
	}))

	const packageUsageQuery = scope.query(({ host }) => ({
		queryKey: ['package-manager', 'usage'] as const,
		queryFn: () => readPackageUsage(host),
	}))

	const registry = {
		search: scope.queryFamily(
			({ api }, { query, includeAll }: { query: string; includeAll: boolean }) => ({
				queryKey: ['package-manager', 'registry-search', query, includeAll] as const,
				queryFn: () => api.searchRegistryDto(query, includeAll),
				staleTime: 30_000,
			}),
		),
		inspect: scope.queryFamily(({ api }, spec: string) => ({
			queryKey: ['package-manager', 'registry-inspect', spec] as const,
			queryFn: () => api.inspectRegistryDto(spec),
			staleTime: 30_000,
		})),
	}
	const localPackageQuery = scope.queryFamily(({ api }, location: LocalPackageLocation) => ({
		queryKey: ['package-manager', 'local-package', location.source, location.path] as const,
		queryFn: () => api.localPackageDto(location),
	}))
	const prepareInstallMutation = scope.mutation(({ api }) => ({
		mutationFn: (input: PrepareInstallInput) =>
			input.kind === 'direct'
				? api.prepareInstallDto(input.specs)
				: api.prepareMarketInstallDto(input.requests),
	}))

	const confirmInstallMutation = scope.mutation(({ api }) => ({
		mutationFn: (planId: string) => api.confirmInstallDto(planId),
		workbench: {
			invalidates: [packageManagerSnapshotQuery, packageUsageQuery, localPackageQuery.all()],
		},
	}))

	const marketPackagesQuery = scope.queryFamily(
		({ api }, input: Readonly<{ marketId: string; query: MarketPackageQuery }>) => ({
			queryKey: ['package-manager', 'market', input.marketId, input.query] as const,
			queryFn: () => api.marketPackagesDto(input.marketId, input.query),
			staleTime: 30_000,
		}),
	)

	const marketFacetsQuery = scope.queryFamily(
		({ api }, input: Readonly<{ marketId: string; filters: MarketCatalogFilters }>) => ({
			queryKey: ['package-manager', 'market-facets', input.marketId, input.filters] as const,
			queryFn: () => api.marketFacetsDto(input.marketId, input.filters),
			staleTime: 30_000,
		}),
	)

	const marketPackageQuery = scope.queryFamily(
		({ api }, input: Readonly<{ marketId: string; registry: string; name: string }>) => ({
			queryKey: ['package-manager', 'package', input.marketId, input.registry, input.name] as const,
			queryFn: () => api.marketPackageDto(input.marketId, input.name, input.registry),
			staleTime: 30_000,
		}),
	)

	const marketReleaseQuery = scope.queryFamily(({ api }, input: MarketInstallRequest) => ({
		queryKey: [
			'package-manager',
			'release',
			input.marketId,
			input.registry,
			input.name,
			input.version,
		] as const,
		queryFn: () => api.marketReleaseDto(input.marketId, input.name, input.version, input.registry),
		staleTime: 30_000,
	}))

	const marketReleasesQuery = scope.queryFamily(
		({ api }, input: Readonly<{ marketId: string; name: string; query: MarketReleaseQuery }>) => ({
			queryKey: ['package-manager', 'releases', input.marketId, input.name, input.query] as const,
			queryFn: () => api.marketReleasesDto(input.marketId, input.name, input.query),
			staleTime: 30_000,
		}),
	)

	const removePackagesMutation = scope.mutation(({ api }) => ({
		mutationFn: ({
			names,
			expectedRevision,
		}: Readonly<{ names: readonly string[]; expectedRevision: number }>) =>
			api.removeDto(names, expectedRevision),
		workbench: {
			invalidates: [packageManagerSnapshotQuery, packageUsageQuery, localPackageQuery.all()],
		},
	}))

	return {
		registry,
		localPackageQuery,
		usePackageManager() {
			return {
				snapshotQuery: packageManagerSnapshotQuery.useQuery(),
				usageQuery: packageUsageQuery.useQuery(),
				preparation: prepareInstallMutation.useMutation(),
				confirmation: confirmInstallMutation.useMutation(),
				removal: removePackagesMutation.useMutation(),
			}
		},
		marketPackagesQuery,
		marketFacetsQuery,
		marketPackageQuery,
		marketReleaseQuery,
		marketReleasesQuery,
	}
}

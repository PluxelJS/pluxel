import type { WorkbenchRendererScope } from '@pluxel/workbench/react'
import type { PackageManagerWorkbench } from '../workbench.ts'
import type { MarketInstallRequest, MarketPackageQuery, MarketReleaseQuery } from '../contracts.ts'

export type PrepareInstallInput =
	| Readonly<{ kind: 'direct'; specs: readonly string[] }>
	| (Readonly<{ kind: 'market' }> & MarketInstallRequest)

export function createPackageManagerResources(
	scope: WorkbenchRendererScope<typeof PackageManagerWorkbench.manager>,
) {
	const packageManagerSnapshotQuery = scope.query(({ api }) => ({
		queryKey: ['package-manager', 'snapshot'] as const,
		queryFn: () => api.snapshotDto(),
	}))

	const prepareInstallMutation = scope.mutation(({ api }) => ({
		mutationFn: (input: PrepareInstallInput) =>
			input.kind === 'direct'
				? api.prepareInstallDto(input.specs)
				: api.prepareMarketInstallDto({
						marketId: input.marketId,
						registry: input.registry,
						name: input.name,
						version: input.version,
					}),
	}))

	const confirmInstallMutation = scope.mutation(({ api }) => ({
		mutationFn: (planId: string) => api.confirmInstallDto(planId),
		workbench: {
			invalidates: [packageManagerSnapshotQuery],
		},
	}))

	const marketPackagesQuery = scope.queryFamily(
		({ api }, input: Readonly<{ marketId: string; query: MarketPackageQuery }>) => ({
			queryKey: ['package-manager', 'market', input.marketId, input.query] as const,
			queryFn: () => api.marketPackagesDto(input.marketId, input.query),
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
		mutationFn: (names: readonly string[]) => api.removeDto(names),
		workbench: {
			invalidates: [packageManagerSnapshotQuery],
		},
	}))

	return {
		packageManagerSnapshotQuery,
		prepareInstallMutation,
		confirmInstallMutation,
		marketPackagesQuery,
		marketPackageQuery,
		marketReleaseQuery,
		marketReleasesQuery,
		removePackagesMutation,
	}
}

import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { PackageManagerWorkbench } from '../workbench.ts'
import type { MarketInstallRequest, MarketPackageQuery, MarketReleaseQuery } from '../contracts.ts'

export const managerScope = createWorkbenchRenderer(PackageManagerWorkbench.manager)

export const packageManagerSnapshotQuery = managerScope.query(({ api }) => ({
	queryKey: ['package-manager', 'snapshot'] as const,
	queryFn: () => api.snapshotDto(),
}))

export type PrepareInstallInput =
	| Readonly<{ kind: 'direct'; specs: readonly string[] }>
	| (Readonly<{ kind: 'market' }> & MarketInstallRequest)

export const prepareInstallMutation = managerScope.mutation(({ api }) => ({
	mutationFn: (input: PrepareInstallInput) =>
		input.kind === 'direct'
			? api.prepareInstallDto(input.specs)
			: api.prepareMarketInstallDto({
					marketId: input.marketId,
					name: input.name,
					version: input.version,
				}),
}))

export const confirmInstallMutation = managerScope.mutation(({ api }) => ({
	mutationFn: (planId: string) => api.confirmInstallDto(planId),
	workbench: {
		invalidates: [packageManagerSnapshotQuery],
	},
}))

export const marketPackagesQuery = managerScope.queryFamily(
	({ api }, input: Readonly<{ marketId: string; query: MarketPackageQuery }>) => ({
		queryKey: ['package-manager', 'market', input.marketId, input.query] as const,
		queryFn: () => api.marketPackagesDto(input.marketId, input.query),
		staleTime: 30_000,
	}),
)

export const marketReleaseQuery = managerScope.queryFamily(
	({ api }, input: MarketInstallRequest) => ({
		queryKey: ['package-manager', 'release', input.marketId, input.name, input.version] as const,
		queryFn: () => api.marketReleaseDto(input.marketId, input.name, input.version),
		staleTime: 30_000,
	}),
)

export const marketReleasesQuery = managerScope.queryFamily(
	({ api }, input: Readonly<{ marketId: string; name: string; query: MarketReleaseQuery }>) => ({
		queryKey: ['package-manager', 'releases', input.marketId, input.name, input.query] as const,
		queryFn: () => api.marketReleasesDto(input.marketId, input.name, input.query),
		staleTime: 30_000,
	}),
)

export const removePackagesMutation = managerScope.mutation(({ api }) => ({
	mutationFn: (names: readonly string[]) => api.removeDto(names),
	workbench: {
		invalidates: [packageManagerSnapshotQuery],
	},
}))

import type { RpcTarget } from 'capnweb'
import type {
	PackageMarket,
	MarketCatalogFilters,
	MarketCatalogFacets,
	MarketPackageQuery,
	MarketReleaseQuery,
	MarketPackagePage,
	MarketPackageDetail,
	MarketReleasePage,
	MarketRelease,
	MarketReadResult,
	MarketInstallRequest,
} from './market-contracts.ts'
export type {
	PackageMarket,
	MarketCatalogFilters,
	MarketCatalogFacets,
	MarketPackageQuery,
	MarketReleaseQuery,
	MarketPackageSummary,
	MarketPackagePage,
	MarketPackageDetail,
	MarketReleasePage,
	MarketRelease,
	MarketReadResult,
	MarketPackageIdentity,
	MarketReleaseIdentity,
	MarketInstallRequest,
} from './market-contracts.ts'

export const packageMutationLimit = 100

export type ManagedPackage = Readonly<{
	name: string
	requested: string
	installedVersion: string | null
	/** Registry of the market release checked for this materialization, if known. */
	marketRegistry?: string
	/** Published source entry filename, or `null` while the package is not materialized/published. */
	entryFile: string | null
}>

export type PackageMutationFailure = Readonly<{
	input: string
	code: 'INVALID_SPEC' | 'INSTALL_FAILED' | 'REMOVE_FAILED' | 'INVALID_PLAN' | 'MARKET_FAILED'
	message: string
}>

export type PackageMutationResult =
	| Readonly<{
			ok: true
			succeeded: readonly string[]
			failed: readonly []
	  }>
	| Readonly<{
			ok: false
			succeeded: readonly string[]
			failed: readonly [PackageMutationFailure, ...PackageMutationFailure[]]
	  }>

/** Detached installation/publication state after preceding admitted operations settle. */
export type PackageManagerSnapshot = Readonly<{
	revision: number
	engine: string
	rootDir: string
	entriesDir: string
	packages: readonly ManagedPackage[]
	/** Removed from the installation selection, but their source entries still need withdrawal. */
	pendingRemovals: readonly string[]
	/** Reported by the latest committed install in this session; empty before the first install. */
	dependenciesWithBuildScripts: readonly string[]
	markets: readonly PackageMarket[]
	sourceUpdates: 'live' | 'next-start' | null
	ignoreScripts: boolean
	allowBuilds: readonly string[]
}>

/** A detached preview of one materialized installation. Preparing again replaces the previous plan. */
export type PackageInstallPlan = Readonly<{
	id: string
	baseRevision: number
	expiresAt: number
	requested: readonly string[]
	/** All top-level managed packages; changed also includes dependency graph changes. */
	packages: readonly Readonly<{
		name: string
		requested: string
		version: string
		integrity: string
		previousVersion: string | null
		/** Previously recorded source when reviewing a selected market release. */
		previousMarketRegistry?: string
		changed: boolean
		/** Selected from this market and checked against pnpm's registry, exact version and integrity. */
		market?: Readonly<{ marketId: string; registry: string }>
	}>[]
	sourceUpdates: 'live' | 'next-start' | null
	dependenciesWithBuildScripts: readonly string[]
}>

export type PackagePreparationResult =
	| Readonly<{ ok: true; plan: PackageInstallPlan }>
	| Readonly<{ ok: false; failed: readonly PackageMutationFailure[] }>

export interface PackageManagerApi extends RpcTarget {
	/** Queued with mutations; rejects after the owner starts closing. */
	snapshotDto(): Promise<PackageManagerSnapshot>
	installDto(specs: readonly string[]): Promise<PackageMutationResult>
	prepareInstallDto(specs: readonly string[]): Promise<PackagePreparationResult>
	confirmInstallDto(planId: string): Promise<PackageMutationResult>
	marketPackagesDto(
		marketId: string,
		query?: MarketPackageQuery,
	): Promise<MarketReadResult<MarketPackagePage>>
	marketFacetsDto(
		marketId: string,
		filters?: MarketCatalogFilters,
	): Promise<MarketReadResult<MarketCatalogFacets>>
	/** Read package metadata even without checked releases; omitting registry selects public npm. */
	marketPackageDto(
		marketId: string,
		name: string,
		registry?: string,
	): Promise<MarketReadResult<MarketPackageDetail>>
	/** Read one exact release; omitting registry selects public npm. */
	marketReleaseDto(
		marketId: string,
		name: string,
		version: string,
		registry?: string,
	): Promise<MarketReadResult<MarketRelease>>
	marketReleasesDto(
		marketId: string,
		name: string,
		query?: MarketReleaseQuery,
	): Promise<MarketReadResult<MarketReleasePage>>
	/** One preview for all selected releases, with a single exact version per package name. */
	prepareMarketInstallDto(
		requests: readonly MarketInstallRequest[],
	): Promise<PackagePreparationResult>
	/** Withdraw the reviewed entries only if their installation revision is still current. */
	removeDto(names: readonly string[], expectedRevision: number): Promise<PackageMutationResult>
}

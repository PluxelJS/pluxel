import type { RpcTarget } from 'capnweb'
import type {
	PackageMarket,
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

export type ManagedPackage = Readonly<{
	name: string
	requested: string
	installedVersion: string | null
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
		changed: boolean
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
	prepareMarketInstallDto(request: MarketInstallRequest): Promise<PackagePreparationResult>
	removeDto(names: readonly string[]): Promise<PackageMutationResult>
}

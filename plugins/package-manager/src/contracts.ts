import type { RpcTarget } from 'capnweb'

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

export type PackageMarket = Readonly<{ id: string; url: string }>

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

export type MarketPackageQuery = Readonly<{ query?: string; cursor?: string; limit?: number }>
export type MarketReleaseQuery = Readonly<{ cursor?: string; limit?: number }>
export type MarketPackageSummary = Readonly<{
	name: string
	description: string | null
	latest: string | null
	repository: string | null
	indexedVersions: number
	observedAt: number
}>
export type MarketPackagePage = Readonly<{
	packages: readonly MarketPackageSummary[]
	nextCursor: string | null
}>
export type MarketReleasePage = Readonly<{
	releases: readonly Readonly<{ version: string; integrity: string; checkedAt: number }>[]
	nextCursor: string | null
	/** This is the indexed subset, not a complete npm version history. */
	coverage: 'indexed-only'
}>
export type MarketRelease = Readonly<{
	name: string
	version: string
	registry: string
	integrity: string
	checkedAt: number
	provenance:
		| Readonly<{ status: 'missing' }>
		| Readonly<{ status: 'verified'; repository: string; commit: string; buildUrl: string | null }>
	peerDependencies: Readonly<Record<string, string>>
	pluginPackages: Readonly<Record<string, 'required' | 'optional'>>
}>
export type MarketReadResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{
			ok: false
			error: Readonly<{
				code: 'UNKNOWN_MARKET' | 'INVALID_QUERY' | 'MARKET_UNAVAILABLE' | 'INVALID_RESPONSE'
				message: string
			}>
	  }>
export type MarketInstallRequest = Readonly<{ marketId: string; name: string; version: string }>

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
	marketReleaseDto(
		marketId: string,
		name: string,
		version: string,
	): Promise<MarketReadResult<MarketRelease>>
	marketReleasesDto(
		marketId: string,
		name: string,
		query?: MarketReleaseQuery,
	): Promise<MarketReadResult<MarketReleasePage>>
	prepareMarketInstallDto(request: MarketInstallRequest): Promise<PackagePreparationResult>
	removeDto(names: readonly string[]): Promise<PackageMutationResult>
}

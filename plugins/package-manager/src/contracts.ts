import type { PackageDocument } from './package-document.ts'
import type {
	PluginSourceDefinition,
	PluginSourceImpact,
	PluginSourceDependencyReview,
} from '@pluxel/host/sources'
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

export type LocalPackageLocation = Readonly<{
	source: 'managed' | 'application'
	path: readonly string[]
}>
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
	code:
		| 'INVALID_SPEC'
		| 'INSTALL_FAILED'
		| 'REMOVE_FAILED'
		| 'INVALID_PLAN'
		| 'MARKET_FAILED'
		| 'SOURCE_CONFLICT'
		| 'HOST_GRAPH_BUSY'
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

/** `succeeded` lists successful requests. Entry lists include every reviewed source that reached its target state. */
export type PackageInstallConfirmation = PackageMutationResult &
	Readonly<{
		published: readonly string[]
		withdrawn: readonly string[]
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

/** Predicted changes to package-root definitions, with current direct consumers from the Host. */
export type PackageHostImpact = Readonly<{
	name: string
	definitionsKnown: boolean
	definitions: readonly (PluginSourceDefinition &
		Readonly<{
			change: 'add' | 'replace' | 'remove' | 'unverified'
			nodes: PluginSourceImpact['definitions'][number]['nodes']
		}>)[]
}>

/** A detached preview of one materialized installation. Preparing again replaces the previous plan. */
export type PackageInstallPlan = Readonly<{
	id: string
	/** Changed source entries only. Null when the store runs independently of a Host. */
	hostImpact: readonly PackageHostImpact[] | null
	/** Predicted policy changes for the full batch under current intents. */
	dependencyReview: PluginSourceDependencyReview | null
	/** Previously removed packages whose remaining wrappers will be withdrawn during confirmation. */
	pendingRemovals: readonly string[]
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
		/** Parents that brought this additional required plugin into the plan. */
		requiredBy?: readonly Readonly<{ name: string; range: string }>[]
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

export type RegistryCandidate = Readonly<{
	name: string
	version: string
	description: string | null
}>
export type RegistrySearch = Readonly<{ registry: string; packages: readonly RegistryCandidate[] }>
export type RegistryInspection = RegistryCandidate &
	Readonly<{
		registry: string
		check:
			| { ok: true; coreRange: string; coreVersion: string; entry: string }
			| { ok: false; reason: string }
	}>

export interface PackageManagerApi extends RpcTarget {
	/** Keyword discovery in the registry selected by the application’s pnpm configuration. */
	searchRegistryDto(query: string, includeAll: boolean): Promise<RegistrySearch>
	/** Read the selected version’s registry manifest without materializing its dependencies. */
	inspectRegistryDto(spec: string): Promise<RegistryInspection>
	localPackageDto(location: LocalPackageLocation): Promise<PackageDocument | null>
	snapshotDto(): Promise<PackageManagerSnapshot>
	installDto(specs: readonly string[]): Promise<PackageMutationResult>
	prepareInstallDto(specs: readonly string[]): Promise<PackagePreparationResult>
	confirmInstallDto(planId: string): Promise<PackageInstallConfirmation>
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

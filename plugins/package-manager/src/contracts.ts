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
	code: 'INVALID_SPEC' | 'INSTALL_FAILED' | 'REMOVE_FAILED'
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
}>

export interface PackageManagerApi extends RpcTarget {
	/** Queued with mutations; rejects after the owner starts closing. */
	snapshotDto(): Promise<PackageManagerSnapshot>
	installDto(specs: readonly string[]): Promise<PackageMutationResult>
	removeDto(names: readonly string[]): Promise<PackageMutationResult>
}

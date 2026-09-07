import type { RpcTarget } from '@pluxel/runtime/capnweb'

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

export type PackageManagerSnapshot = Readonly<{
	revision: number
	engine: string
	rootDir: string
	entriesDir: string
	packages: readonly ManagedPackage[]
	dependenciesWithBuildScripts: readonly string[]
}>

export interface PackageManagerApi extends RpcTarget {
	snapshot(): Promise<PackageManagerSnapshot>
	install(specs: readonly string[]): Promise<PackageMutationResult>
	remove(names: readonly string[]): Promise<PackageMutationResult>
}

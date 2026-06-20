import type { EntryResolutionOk, ScanTaskOptions } from '../scan/types'
import type { NormalizedPackageSpecifier } from './specifiers'

export type { NormalizedPackageSpecifier } from './specifiers'

export type PackageServiceErrorCode =
	| 'INVALID_SPEC'
	| 'INSTALL_FAILED'
	| 'UNINSTALL_FAILED'
	| 'RESOLUTION_FAILED'
	| 'IMPORT_FAILED'

export type PackageInstallStatus = 'installed' | 'reused'

export interface PackageInstallResult {
	spec: NormalizedPackageSpecifier
	target: string
	status: PackageInstallStatus
	installedAt: number
}

export interface PackageMetadata {
	spec: NormalizedPackageSpecifier
	resolution: EntryResolutionOk
	dependOn: string[]
	manifestPath?: string
	manifestVersion?: string
	resolvedVersion?: string
}

export interface PackageLoadResult extends PackageMetadata {
	module: Record<string, unknown>
	moduleId: string
	isAnchor: boolean
	install?: PackageInstallResult | undefined
	loadedAt: number
}

export type PackageLoadIssueSource = 'load' | 'restore' | 'retry'

export interface PackageLoadIssue {
	spec: NormalizedPackageSpecifier
	source: PackageLoadIssueSource
	message: string
	error: unknown
	stack?: string | undefined
	recordedAt: number
	moduleId?: string | undefined
}

export type PackageUninstallStatus = 'uninstalled' | 'failed'

export interface PackageUninstallResult {
	spec: NormalizedPackageSpecifier
	status: PackageUninstallStatus
	error?: unknown
}

export type PackageRemovalStatus = 'removed' | 'failed'

export interface PackageRemovalResult {
	spec: NormalizedPackageSpecifier
	status: PackageRemovalStatus
	error?: unknown
}

export interface PackageReloadResult {
	spec: NormalizedPackageSpecifier
	record?: PackageLoadResult
	error?: unknown
}

export interface PackageInventoryEntry {
	spec: NormalizedPackageSpecifier
	installedVersion?: string | undefined
	requestedVersion?: string | undefined
	loaded: boolean
	moduleId?: string | undefined
	issues?: PackageLoadIssue[] | undefined
	blocked?: boolean | undefined
}

export interface ListInstalledPackagesOptions {
	includeUntracked?: boolean
}

export interface InstallOptions {
	cwd?: string
	dev?: boolean
	workspace?: boolean
	env?: Record<string, string | undefined>
	silent?: boolean
	packageManager?: string
	global?: boolean
	dry?: boolean
	registry?: string
	registries?: Record<string, string>
	force?: boolean
	installPeerDependencies?: boolean
}

/** Load options only keep resolution-related settings. */
export interface LoadOptions {
	scan?: ScanTaskOptions
	resolvedEntry?: EntryResolutionOk
	/** Override auto install options. */
	install?: InstallOptions
}

export interface RetryOptions extends LoadOptions {
	/** Reinstall before retrying load. */
	reinstall?: boolean
	/** Force a fresh import. */
	fresh?: boolean
}

export interface PackagePolicy {
	allowInstall?: boolean
	allowUninstall?: boolean
	allowedRegistries?: string[]
	allowedScopes?: string[]
	allowPrerelease?: boolean
	allowedTags?: string[]
}

export interface PackageServiceConfig {
	install?: InstallOptions
	scan?: ScanTaskOptions
	preferFreshImport?: boolean
	policy?: PackagePolicy
	state?: {
		enabled?: boolean
		file?: string
		debounceMs?: number
	}
}

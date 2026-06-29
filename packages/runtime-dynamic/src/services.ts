export {
	LoaderService,
	type BuiltinForkSpec,
	type BuiltinPluginSpec,
	type LoaderApi,
	type LoaderBatch,
	type LoaderSyncModulesOptions,
	type PreloadBuiltinsOptions,
	type ReplaceModuleResult,
	type RemovalScope,
} from './loader/LoaderService'

export { createLoaderRuntimeRoute } from './catalog/LoaderRuntimeRoute'

export {
	PackageService,
	PackageServiceError,
	type InstallOptions,
	type ListInstalledPackagesOptions,
	type LoadOptions,
	type PackageInstallResult,
	type PackageInstallStatus,
	type PackageInventoryEntry,
	type PackageLoadIssue,
	type PackageLoadIssueSource,
	type PackageLoadResult,
	type PackageMetadata,
	type PackageReloadResult,
	type PackageRemovalResult,
	type PackageServiceConfig,
	type PackageServiceErrorCode,
	type PackageUninstallResult,
	type RetryOptions,
} from './package/PackageService'
export {
	fromSnapshot,
	normalizeSpecifier,
	toSnapshot,
	tryNormalizeSpecifier,
	withTag,
	withVersion,
	type NormalizedPackageSpecifier,
	type PackageSpecifierInput,
	type PackageSpecifierSnapshot,
} from './package/specifiers'

export {
	ScanService,
	isEntryOk,
	isPackageEntryOk,
	type EntryResolution,
	type EntryResolutionOk,
	type PackageNode,
	type PackageSelector,
	type ScanDiagnostic,
	type ScanGraph,
	type ScanOptionsInput,
	type ScanServiceConfig,
	type ScanSnapshot,
	type ScanStats,
	type ScanTaskOptions,
	type WorkspaceEntryInfo,
} from './scan/ScanService'

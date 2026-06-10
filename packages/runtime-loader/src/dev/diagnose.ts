export {
	DEFAULT_LOADER_DEV_CONFIG_BASENAME,
	backupAndRewriteLoaderDevConfigV1,
	createDefaultLoaderDevConfigV1,
	defaultLoaderDevConfigHeaderComment,
	ensureLoaderDevConfigV1,
	parseLoaderDevConfigV1Jsonc,
	readLoaderDevConfigV1,
	resolveDefaultLoaderDevConfigPath,
	validateLoaderDevConfigV1Strict,
	writeLoaderDevConfigV1,
} from './diagnose/config'
export type { PluxelLoaderDevConfig, PluxelLoaderDevConfigV1 } from './diagnose/config'
export { nodeLoaderDevWorkspaceFs, nodeWorkspaceFs } from './diagnose/fs'
export type { LoaderDevWorkspaceFs, WorkspaceFs } from './diagnose/fs'

export {
	discoverPluginsFromPackages,
	discoverWorkspacePlugins,
	scanWorkspacePackages,
} from './diagnose/discover'
export type {
	DiscoverWorkspacePluginsInput,
	DiscoveredPlugin,
	WorkspacePackage,
} from './diagnose/discover'

export {
	buildWorkspaceSnapshotFromScan,
	diagnoseWorkspace,
	mergeLoaderDevProfile,
	resolveLoaderDevConfigPathFromCwd,
	resolveLoaderDevRootsExpanded,
} from './diagnose/diagnose'
export type {
	DiagnoseWorkspaceInput,
	DiagnoseWorkspaceResult,
	WorkspaceSnapshot,
} from './diagnose/diagnose'

export {
	getLoaderDevProfileBuiltinPackages,
	getLoaderDevProfileEnabledPackages,
	readLoaderDevConfigRaw,
	readLoaderDevProfileView,
	resolveLoaderDevConfigPath,
	resolveLoaderDevWorkspace,
} from './diagnose/profile'
export type {
	LoaderDevProfileRef,
	LoaderDevProfileView,
	ResolveLoaderDevWorkspaceOptions,
} from './diagnose/profile'

export { toPosix, toRootRelative, uniqPreserveOrder, uniqSorted } from './diagnose/utils'

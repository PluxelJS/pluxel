export {
	DEFAULT_LOADER_HMR_CONFIG_BASENAME,
	backupAndRewriteLoaderHmrConfigV1,
	createDefaultLoaderHmrConfigV1,
	defaultLoaderHmrConfigHeaderComment,
	ensureLoaderHmrConfigV1,
	parseLoaderHmrConfigV1Jsonc,
	readLoaderHmrConfigV1,
	resolveDefaultLoaderHmrConfigPath,
	validateLoaderHmrConfigV1Strict,
	writeLoaderHmrConfigV1,
} from './diagnose/config'
export type { PluxelLoaderHmrConfig, PluxelLoaderHmrConfigV1 } from './diagnose/config'
export { nodeLoaderHmrWorkspaceFs, nodeWorkspaceFs } from './diagnose/fs'
export type { LoaderHmrWorkspaceFs, WorkspaceFs } from './diagnose/fs'

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
	buildWorkspaceSnapshotFromScan as buildLoaderHmrWorkspaceFromScan,
	diagnoseWorkspace,
	diagnoseWorkspace as diagnoseLoaderHmrWorkspace,
	mergeLoaderHmrProfile,
	resolveLoaderHmrConfigPathFromCwd,
	resolveLoaderHmrRootsExpanded,
} from './diagnose/diagnose'
export type {
	DiagnoseWorkspaceInput,
	DiagnoseWorkspaceResult,
	WorkspaceSnapshot,
	WorkspaceSnapshot as LoaderHmrWorkspace,
} from './diagnose/diagnose'

export {
	getLoaderHmrProfileBuiltinPackages,
	getLoaderHmrProfileEnabledPackages,
	readLoaderHmrConfigRaw,
	readLoaderHmrProfileView,
	resolveLoaderHmrConfigPath,
	resolveLoaderHmrWorkspace,
} from './diagnose/profile'
export type {
	LoaderHmrProfileRef,
	LoaderHmrProfileView,
	ResolveLoaderHmrWorkspaceOptions,
} from './diagnose/profile'

export { toPosix, toRootRelative, uniqPreserveOrder, uniqSorted } from './diagnose/utils'

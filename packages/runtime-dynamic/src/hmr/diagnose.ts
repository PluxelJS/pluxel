export {
	DEFAULT_LOADER_HMR_CONFIG_BASENAME,
	backupAndRewriteLoaderHmrConfigV2,
	createDefaultLoaderHmrConfigV2,
	defaultLoaderHmrConfigHeaderComment,
	ensureLoaderHmrConfigV2,
	parseLoaderHmrConfigV2Jsonc,
	readLoaderHmrConfigV2,
	resolveDefaultLoaderHmrConfigPath,
	validateLoaderHmrConfigV2Strict,
	writeLoaderHmrConfigV2,
} from './diagnose/config'
export type { PluxelLoaderHmrConfig, PluxelLoaderHmrConfigV2 } from './diagnose/config'
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

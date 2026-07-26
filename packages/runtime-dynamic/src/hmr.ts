import './services'

export {
	DEFAULT_LOADER_HMR_CONFIG_BASENAME,
	backupAndRewriteLoaderHmrConfigV1,
	createDefaultLoaderHmrConfigV1,
	defaultLoaderHmrConfigHeaderComment,
	diagnoseWorkspace as diagnoseLoaderHmrWorkspace,
	ensureLoaderHmrConfigV1,
	nodeLoaderHmrWorkspaceFs,
	nodeWorkspaceFs,
	parseLoaderHmrConfigV1Jsonc,
	readLoaderHmrConfigV1,
	resolveDefaultLoaderHmrConfigPath,
	validateLoaderHmrConfigV1Strict,
	writeLoaderHmrConfigV1,
} from './hmr/diagnose'
export type {
	DiscoverWorkspacePluginsInput,
	DiscoveredPlugin,
	DiagnoseWorkspaceInput as DiagnoseLoaderHmrWorkspaceInput,
	DiagnoseWorkspaceResult as DiagnoseLoaderHmrWorkspaceResult,
	LoaderHmrWorkspaceFs,
	PluxelLoaderHmrConfig,
	PluxelLoaderHmrConfigV1,
	WorkspacePackage,
	WorkspaceFs,
	WorkspaceSnapshot as LoaderHmrWorkspace,
} from './hmr/diagnose'
export {
	buildWorkspaceSnapshotFromScan as buildLoaderHmrWorkspaceFromScan,
	discoverPluginsFromPackages,
	discoverWorkspacePlugins,
	getLoaderHmrProfileBuiltinPackages,
	getLoaderHmrProfileEnabledPackages,
	mergeLoaderHmrProfile,
	readLoaderHmrConfigRaw,
	readLoaderHmrProfileView,
	resolveLoaderHmrConfigPath,
	resolveLoaderHmrConfigPathFromCwd,
	resolveLoaderHmrRootsExpanded,
	resolveLoaderHmrWorkspace,
	scanWorkspacePackages,
} from './hmr/diagnose'
export type { BuiltinsFromDistEntry, LoaderHmrWorkspaceSnapshot } from './hmr/snapshot'
export { assertLoaderHmrWorkspace } from './hmr/snapshot'
export type { LoaderHmrDependencyConfig } from './hmr/engine/config'
export type { LoaderHmrService } from './hmr/engine/LoaderHmrService'
export { bootPlannedLoaderHmrHost, planLoaderHmrHostFromConfig } from './hmr/host'

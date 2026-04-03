export {
	DEFAULT_HMR_CONFIG_BASENAME,
	backupAndRewriteHmrConfigV1,
	createDefaultHmrConfigV1,
	defaultHmrConfigHeaderComment,
	ensureHmrConfigV1,
	parseHmrConfigV1Jsonc,
	readHmrConfigV1,
	resolveDefaultHmrConfigPath,
	validateHmrConfigV1Strict,
	writeHmrConfigV1,
} from './diagnose/config'
export type { PluxelHmrConfig, PluxelHmrConfigV1 } from './diagnose/config'
export { nodeHmrWorkspaceFs, nodeWorkspaceFs } from './diagnose/fs'
export type { HmrWorkspaceFs, WorkspaceFs } from './diagnose/fs'

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
	mergeHmrProfile,
	resolveHmrConfigPathFromCwd,
	resolveHmrRootsExpanded,
} from './diagnose/diagnose'
export type {
	DiagnoseWorkspaceInput,
	DiagnoseWorkspaceResult,
	WorkspaceSnapshot,
} from './diagnose/diagnose'

export {
	getHmrProfileBuiltinPackages,
	getHmrProfileEnabledPackages,
	readHmrConfig,
	readHmrProfileView,
	resolveHmrConfigPath,
	resolveHmrWorkspaceSnapshot,
} from './diagnose/profile'
export type {
	HmrProfileRef,
	HmrProfileView,
	ResolveHmrWorkspaceSnapshotOptions,
} from './diagnose/profile'

export { toPosix, toRootRelative, uniqPreserveOrder, uniqSorted } from './diagnose/utils'

// protocol-types.ts - RPC 类型定义（源头）

export type PluginStatusAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable'
export type ConfigPatch = Record<string, unknown>
export type ConfigValidationErrors = Record<
	string,
	Record<string, { message: string; path: string[] }[]>
>

export type ConfigResultOk = {
	ok: true
	config: Record<string, unknown>
	defaults: Record<string, unknown>
	saved?: boolean
}

export type ConfigResultErr = {
	ok: false
	code: 'config_not_found' | 'validation_failed'
	message?: string
	errors?: ConfigValidationErrors
	defaults?: Record<string, unknown>
}

export type ConfigResult = ConfigResultOk | ConfigResultErr

export type SchemaResultOk = {
	ok: true
	schemaSource: Record<string, string>
	defaults: Record<string, unknown>
}

export type SchemaResultErr = {
	ok: false
	code: 'plugin_not_found' | 'schema_not_found'
	message: string
}

export type SchemaResult = SchemaResultOk | SchemaResultErr

export type PluginStatusBatchAction = { name: string; action: PluginStatusAction }
export type PluginStatusMutationResult = {
	name: string
	ok: boolean
	code?: string
	error?: string
	isRunning?: boolean
	isEnabled?: boolean
	lifecycleStage?: PluginStatusEntryLifecycleStage
}
export type PluginStatusBatchResult = {
	ok: boolean
	results: PluginStatusMutationResult[]
	commitError?: string
}

export type PluginStatusEntryLifecycleStage = 'running' | 'stopped' | 'disabled'

export type PluginDependencyKind = 'plugin' | 'base' | 'forkable'

export type PluginGroupInput = {
	groupId: string
	name: string
	pluginIds: string[]
}

export type PluginGroup = {
	__typename?: 'PluginGroup'
	groupId: string
	name: string
	pluginIds: string[]
}

export type PluginDependencyOption = {
	name: string
	isRunning: boolean
	isEnabled: boolean
}

export type PluginDependencyState = {
	index: number
	token: string
	kind: PluginDependencyKind
	effective: string
	isRunning: boolean
	selected: string | null
	baseProvider: string | null
	options: PluginDependencyOption[]
}

export type PluginDependencyMutationResult = {
	ok: boolean
	code?: string
	error?: string
}

export type EnsureForkResult = {
	ok: boolean
	forkName?: string
	code?: string
	error?: string
}

export type BaseProvisionInfo = {
	baseToken: string
	currentDefault: string | null
	isDefault: boolean
	providers: PluginDependencyOption[]
}

export type PackageSpecInput = {
	raw?: string | null
	name?: string | null
	version?: string | null
	tag?: string | null
}

export type PackageIssueSpec = {
	__typename: 'PackageIssueSpec'
	name: string
	version: string | null
	tag: string | null
	target: string
	raw: string
}

export type PackageLoadIssue = {
	__typename: 'PackageLoadIssue'
	spec: PackageIssueSpec
	source: 'load' | 'restore' | 'retry'
	message: string
	error: string | null
	moduleId: string | null
	recordedAt: number
}

export type PackageInventoryEntry = {
	__typename: 'PackageInventoryEntry'
	spec: PackageIssueSpec
	installedVersion: string | null
	requestedVersion: string | null
	loaded: boolean
	moduleId: string | null
	issues: PackageLoadIssue[] | null
}

export type PackageInventoryFilter = {
	includeUntracked?: boolean
}

export type PackageMutationAction =
	| 'install'
	| 'uninstall'
	| 'remove'
	| 'reinstall'
	| 'reload'
	| 'retry'

export type PackageMutationOptions = {
	force?: boolean
	fresh?: boolean
	reinstall?: boolean
}

export type PackageMutationInput = {
	action: PackageMutationAction
	specs: PackageSpecInput[]
	options?: PackageMutationOptions
}

export type PackageMutationResult = {
	__typename: 'PackageMutationResult'
	ok: boolean
	code: string
	spec: PackageIssueSpec | null
	installStatus: 'installed' | 'reused' | null
	error: string | null
}

export type PackageBatchResult = {
	__typename: 'PackageBatchMutationResult'
	ok: boolean
	results: PackageMutationResult[]
	error: string | null
}

export interface PackageHandleApi {
	mutate: (input: PackageMutationInput) => Promise<PackageBatchResult>
	inventory: (filter?: PackageInventoryFilter) => Promise<PackageInventoryEntry[]>
	loadIssues: () => Promise<PackageLoadIssue[]>
}

export interface PluginHandleApi {
	name: string
	detail: () => unknown
	updateStatus: (action: PluginStatusAction) => Promise<PluginStatusMutationResult>
	dependencyState: () => Promise<PluginDependencyState[]>
	setDependencyTarget: (
		index: number,
		targetName: string | null,
	) => Promise<PluginDependencyMutationResult>
	setBaseProvider: (
		baseToken: string,
		providerName: string | null,
	) => Promise<PluginDependencyMutationResult>
	ensureFork: (
		baseName: string,
		forkId: string,
		options?: { enable?: boolean },
	) => Promise<EnsureForkResult>
	baseProvision: () => Promise<BaseProvisionInfo | null>
	schema: () => Promise<SchemaResult>
	config: () => Promise<ConfigResultOk>
	validateConfig: (patch: ConfigPatch) => Promise<ConfigResult>
	saveConfig: (patch: ConfigPatch) => Promise<ConfigResult>
	resetConfig: (keys?: string[]) => Promise<ConfigResult>
}

export interface BuildSnapshotResult {
	ok: boolean
	path?: string
	error?: string
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal'
export type PluginLogLevel = LogLevel | null

export type PluginLevelsSnapshot = {
	/** Includes `'*'` for the default when set. */
	levels: Record<string, PluginLogLevel>
}

export type LoggingHandleApi = {
	getPluginLevels: () => Promise<PluginLevelsSnapshot>
	setPluginLevel: (pluginId: string, level: PluginLogLevel) => Promise<{ ok: true }>
	deletePluginLevel: (pluginId: string) => Promise<{ ok: true }>
	setPluginLevelDefault: (level: PluginLogLevel) => Promise<{ ok: true }>
	deletePluginLevelDefault: () => Promise<{ ok: true }>
	clearPluginLevels: () => Promise<{ ok: true }>
}

export type HmrRpcApi<ExtRpc = Record<string, unknown>> = {
	ping: () => string
	plugin: (name: string) => PluginHandleApi
	package: () => PackageHandleApi
	logging: () => LoggingHandleApi
	ext: ExtRpc
	extensions: () => string[]
	buildSnapshot: () => Promise<BuildSnapshotResult>
	updatePluginStatuses: (actions: PluginStatusBatchAction[]) => Promise<PluginStatusBatchResult>
	updatePluginGroups: (groups: PluginGroupInput[]) => Promise<PluginGroup[]>
}

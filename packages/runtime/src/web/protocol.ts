/**
 * Runtime transport protocol types (client/server shared).
 *
 * Keep protocol contracts and UI extension augmentation in one place so
 * `@pluxel/runtime/web` can stay the canonical browser-facing type surface.
 */

import type { OpPublicDescriptor } from '@pluxel/ops'

/**
 * UI extensibility surface.
 *
 * @example
 * declare module '@pluxel/runtime/web' {
 *   interface ExtensionUiRpcMap {
 *     MyPlugin: MyPluginRpc
 *   }
 *
 *   interface ExtensionUiSseMap {
 *     MyPlugin: MyPluginSsePayload
 *   }
 *
 *   interface ExtensionUiSignalDbMap {
 *     MyPlugin: {
 *       events: DemoEvent
 *     }
 *   }
 * }
 */
export interface ExtensionUiRpcMap {}
export interface ExtensionUiSseMap {}
export interface ExtensionUiSignalDbMap {}

export type PluginStatusAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable'
export type ConfigPatch = Record<string, unknown>
export type ConfigFieldMutation = {
	schemaKey: string
	fieldPath: string
	value: unknown
}
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

export type ExtensionSessionLoadResultOk = {
	ok: true
	input: unknown
	draft: unknown
	prepared: unknown
}

export type ExtensionSessionLoadResultErr = {
	ok: false
	code:
		| 'session_not_found'
		| 'surface_not_found'
		| 'offer_not_found'
		| 'prepare_failed'
		| 'validation_failed'
	message?: string
}

export type ExtensionSessionLoadResult =
	| ExtensionSessionLoadResultOk
	| ExtensionSessionLoadResultErr

export type ExtensionSessionDraftSyncInput = {
	sessionId: string
	draft: unknown
}

export type ExtensionSessionCommitInput = {
	sessionId: string
	result: unknown
}

export type ExtensionSessionMutationResult =
	| {
			ok: true
	  }
	| {
			ok: false
			code:
				| 'session_not_found'
				| 'surface_not_found'
				| 'offer_not_found'
				| 'validation_failed'
				| 'apply_failed'
			message?: string
	  }

export type SchemaResultOk = {
	ok: true
	schemaSource: Record<string, string>
	defaults: Record<string, unknown>
	/**
	 * Optional cfg layout parts (for host-side config layout).
	 *
	 * Extracted from `this.configs.use(cfg(schemaMap)\`...\`)` by build toolchains.
	 */
	layout?: import('./plugin-ui/extensions-contracts').BuiltinMarkdownPart[] | null
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

export type RuntimeOpDescriptor = OpPublicDescriptor
export type RuntimeOpCatalogOwnerKind = 'runtime' | 'plugin' | 'context'
export type RuntimeOpCatalogEntry = {
	id: string
	owner: string
	ownerKind: RuntimeOpCatalogOwnerKind
	pluginId?: string
	descriptor: RuntimeOpDescriptor
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

export type OpsToolsetInput = {
	toolsetId: string
	name: string
	description?: string
	opIds: string[]
}

export type OpsToolset = {
	__typename?: 'OpsToolset'
	toolsetId: string
	name: string
	description?: string
	opIds: string[]
}

export type RuntimeOpToolsetEntry = {
	id: string
	title: string
	description?: string
	tags: string[]
	owner: string
	ownerKind: RuntimeOpCatalogOwnerKind
	pluginId?: string
	mutating: boolean
	confirm: boolean
}

export type RuntimeOpToolsetManifest = {
	toolset: OpsToolset
	tools: RuntimeOpToolsetEntry[]
	missingOpIds: string[]
}

export type PluginDependencyOption = {
	name: string
	isRunning: boolean
	isEnabled: boolean
}

export type PluginDependencyRef = {
	name?: string
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

export type BaseProviderInfo = {
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

export interface BuildSnapshotResult {
	ok: boolean
	path?: string
	error?: string
}

export interface ExtensionSessionHandleApi {
	loadSession: (sessionId: string) => Promise<ExtensionSessionLoadResult>
	syncDraft: (input: ExtensionSessionDraftSyncInput) => Promise<ExtensionSessionMutationResult>
	commitSession: (input: ExtensionSessionCommitInput) => Promise<ExtensionSessionMutationResult>
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

type RuntimeRpcApiContract<ExtRpc = Record<string, unknown>> = {
	ping: () => string
	package: () => PackageHandleApi
	logging: () => LoggingHandleApi
	ui: () => ExtensionSessionHandleApi
	ext: ExtRpc
	extensions: () => string[]
	buildSnapshot: () => Promise<BuildSnapshotResult>
	opsList: () => RuntimeOpDescriptor[]
	opsCatalog: () => RuntimeOpCatalogEntry[]
	opsToolsets: () => OpsToolset[]
	resolveOpsToolset: (toolsetId: string) => RuntimeOpToolsetManifest | null
	opsInvoke: (id: string, input?: unknown) => Promise<unknown>
	opsDispatch: (command: string) => Promise<unknown>
	updateOpsToolsets: (toolsets: OpsToolsetInput[]) => Promise<OpsToolset[]>
	updatePluginGroups: (groups: PluginGroupInput[]) => Promise<PluginGroup[]>
}

export type RuntimeRpcApi = RuntimeRpcApiContract<ExtensionUiRpcMap>

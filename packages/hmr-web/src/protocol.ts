/**
 * HMR protocol types (client/server shared).
 *
 * 说明：
 * - 这里不是“纯类型包”，协议类型与浏览器 client 同属一个包，减少碎片化。
 * - 对外推荐通过 `@pluxel/hmr/services` 做 declaration merging 扩展 `UI.rpc` / `UI.sse`。
 */

/**
 * UI extensibility surface.
 *
 * @example
 * declare module '@pluxel/hmr/services' {
 *   namespace UI {
 *     interface rpc {
 *       MyPlugin: MyPluginRpc
 *     }
 *
 *     interface sse {
 *       MyPlugin: MyPluginSsePayload
 *     }
 *   }
 * }
 */
export declare namespace UI {
	// biome-ignore lint/suspicious/noEmptyInterface: declaration merging target (bridged from @pluxel/hmr/services)
	interface rpc {}
	// biome-ignore lint/suspicious/noEmptyInterface: declaration merging target (bridged from @pluxel/hmr/services)
	interface sse {}
}

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
	lifecycleStage?: string
}
export type PluginStatusBatchResult = {
	ok: boolean
	results: PluginStatusMutationResult[]
	commitError?: string
}

export type PluginDependencyKind = 'plugin' | 'base' | 'forkable'

export type PluginDependencyOption = {
	name: string
	isRunning: boolean
	isEnabled: boolean
}

export type PluginDependencyState = {
	index: number
	token: string
	kind: PluginDependencyKind
	/** current effective target token name (after overrides) */
	effective: string
	isRunning: boolean
	/** persisted selection (index -> targetName), if any */
	selected: string | null
	/** base-token resolution (provider plugin id), when kind === 'base' */
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

export type PackageMutationAction = 'install' | 'uninstall' | 'remove' | 'reinstall' | 'reload' | 'retry'

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
	spec: {
		__typename: 'PackageIssueSpec'
		name: string
		version: string | null
		tag: string | null
		target: string
		raw: string
	} | null
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
	loadIssues: () => unknown
	inventory: (options?: { includeUntracked?: boolean }) => unknown
	mutate: (input: PackageMutationInput) => Promise<PackageBatchResult>
}

export interface PluginHandleApi {
	name: string
	detail: () => unknown
	status: () => unknown
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

/**
 * RPC API contract (client/server).
 */
export interface HmrRpcApi {
	ping: () => string
	plugin: (name: string) => PluginHandleApi
	package: () => PackageHandleApi
	ext: UI.rpc
	extensions: () => string[]
	pluginStatus: () => unknown
	buildSnapshot: () => Promise<BuildSnapshotResult>
	updatePluginStatuses: (actions: PluginStatusBatchAction[]) => Promise<PluginStatusBatchResult>
	pluginGroups: () => unknown
	updatePluginGroups: (groups: unknown) => unknown
}

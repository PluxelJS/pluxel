/**
 * HMR protocol types (client/server shared).
 *
 * 说明：
 * - 这里不是“纯类型包”，协议类型与浏览器 client 同属一个包，减少碎片化。
 * - 对外推荐通过 `@pluxel/hmr/services` 做 declaration merging 扩展 `RpcExtensions` / `SseEvents`。
 * - `@pluxel/hmr-web` 的同名 interface 作为内部/桥接存在（不建议插件直接依赖）。
 */

/**
 * RPC 扩展接口（插件通过 declaration merging 扩展）
 *
 * @example
 * declare module '@pluxel/hmr/services' {
 *   interface RpcExtensions {
 *     MyPlugin: MyPluginRpc
 *   }
 * }
 */
// biome-ignore lint/suspicious/noEmptyInterface: 外部扩展（通过 @pluxel/hmr/services bridge 进来）
export interface RpcExtensions {}

/**
 * SSE 事件接口（插件通过 declaration merging 扩展）
 *
 * key 是 namespace，value 是 payload 的 union/shape。
 */
// biome-ignore lint/suspicious/noEmptyInterface: 外部扩展（通过 @pluxel/hmr/services bridge 进来）
export interface SseEvents {}

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

export type MarketMutationResult = {
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

export type MarketBatchResult = {
	__typename: 'PackageBatchMutationResult'
	ok: boolean
	results: MarketMutationResult[]
	error: string | null
}

export interface MarketHandleApi {
	loadIssues: () => unknown
	inventory: (options?: { includeUntracked?: boolean }) => unknown
	install: (spec: PackageSpecInput, options?: { force?: boolean }) => Promise<MarketMutationResult>
	installMany: (
		specs: PackageSpecInput[],
		options?: { force?: boolean },
	) => Promise<MarketBatchResult>
	uninstall: (spec: PackageSpecInput) => Promise<MarketMutationResult>
	uninstallMany: (specs: PackageSpecInput[]) => Promise<MarketBatchResult>
	remove: (spec: PackageSpecInput) => Promise<MarketMutationResult>
	removeMany: (specs: PackageSpecInput[]) => Promise<MarketBatchResult>
	reinstall: (
		spec: PackageSpecInput,
		options?: { force?: boolean },
	) => Promise<MarketMutationResult>
	reinstallMany: (
		specs: PackageSpecInput[],
		options?: { force?: boolean },
	) => Promise<MarketBatchResult>
	reloadMany: (
		specs: PackageSpecInput[],
		options?: { fresh?: boolean },
	) => Promise<MarketBatchResult>
	retry: (
		spec: PackageSpecInput,
		options?: { reinstall?: boolean; fresh?: boolean },
	) => Promise<MarketMutationResult>
	retryAllFailed: (options?: { reinstall?: boolean; fresh?: boolean }) => Promise<MarketBatchResult>
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
	market: () => MarketHandleApi
	ext: RpcExtensions
	extensions: () => string[]
	pluginStatus: () => unknown
	buildSnapshot: () => Promise<BuildSnapshotResult>
	updatePluginStatuses: (actions: PluginStatusBatchAction[]) => Promise<PluginStatusBatchResult>
	pluginGroups: () => unknown
	updatePluginGroups: (groups: unknown) => unknown
}

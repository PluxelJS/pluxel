/**
 * Runtime transport protocol types (client/server shared).
 *
 * Keep protocol contracts and UI extension augmentation in one place so
 * `@pluxel/runtime/web` can stay the canonical browser-facing type surface.
 */
import type { AgentToolsAdminSnapshot, AgentToolsPolicyInput } from '../agent-tools'
export type { VaultKeyPair } from '../services/vault/types'
export type {
	AgentToolAssignment,
	AgentToolsAdminSnapshot,
	AgentToolsPolicy,
	AgentToolsPolicyInput,
	CommandInventoryItem,
	CommandToolset,
} from '../agent-tools'

export type WorkbenchRpcView = Record<string, unknown>

export type PluginStatusAction =
	| 'start'
	| 'stop'
	| 'restart'
	| 'enable'
	| 'enable-persisted'
	| 'disable'
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

export type SchemaResultOk = {
	ok: true
	schemaSource: Record<string, string>
	defaults: Record<string, unknown>
	/**
	 * Optional cfg layout parts (for host-side config layout).
	 *
	 * Extracted from `this.configs.use(cfg(schemaMap)\`...\`)` by build toolchains.
	 */
	layout?: import('../workbench/document-contracts').BuiltinMarkdownPart[] | null
}

export type SchemaResultErr = {
	ok: false
	code: string
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
	id: string
	groupId: string
	name: string
	pluginIds: string[]
}

export type PluginDependencyOption = {
	name: string
	isRunning: boolean
	isEnabled: boolean
}

export type PluginDependencyRef = {
	name?: string
	isRunning?: boolean
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
	key: string
	name: string
	version: string | null
	tag: string | null
	target: string
	raw: string
}

export type PackageLoadIssue = {
	__typename: 'PackageLoadIssue'
	id: string
	spec: PackageIssueSpec
	source: 'load' | 'restore' | 'retry'
	message: string
	error: string | null
	moduleId: string | null
	recordedAt: number
}

export type PackageInventoryEntry = {
	__typename: 'PackageInventoryEntry'
	id: string
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
	id: string
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

export type PackageManagerSnapshot = {
	__typename: 'PackageManagerSnapshot'
	inventory: PackageInventoryEntry[]
	loadIssues: PackageLoadIssue[]
}

export interface PackageManagerFeatureApi {
	mutate: (input: PackageMutationInput) => Promise<PackageBatchResult>
	snapshot: (filter?: PackageInventoryFilter) => Promise<PackageManagerSnapshot>
	inventory: (filter?: PackageInventoryFilter) => Promise<PackageInventoryEntry[]>
	loadIssues: () => Promise<PackageLoadIssue[]>
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal'
export type RuntimePluginLogLevel = LogLevel | 'off'

export type PluginLogPolicySnapshot = {
	version: 1
	defaultLevel: RuntimePluginLogLevel
	overrides: Record<string, RuntimePluginLogLevel>
}

export type VersionedPluginLogPolicySnapshot = PluginLogPolicySnapshot & {
	revision: number
	persistence: 'none' | 'clean' | 'dirty' | 'failed'
}

export type PluginLogPolicyMutationResult = Pick<
	VersionedPluginLogPolicySnapshot,
	'revision' | 'persistence'
>

export type LoggingHandleApi = {
	getPolicy: () => Promise<VersionedPluginLogPolicySnapshot>
	replacePolicy: (
		expectedRevision: number,
		snapshot: PluginLogPolicySnapshot,
	) => Promise<PluginLogPolicyMutationResult>
	setDefaultLevel: (
		expectedRevision: number,
		level: RuntimePluginLogLevel,
	) => Promise<PluginLogPolicyMutationResult>
	setPluginLevel: (
		expectedRevision: number,
		pluginId: string,
		level: RuntimePluginLogLevel,
	) => Promise<PluginLogPolicyMutationResult>
	clearPluginLevel: (
		expectedRevision: number,
		pluginId: string,
	) => Promise<PluginLogPolicyMutationResult>
	resetPolicy: (expectedRevision: number) => Promise<VersionedPluginLogPolicySnapshot>
}

export type AgentToolsHandleApi = {
	snapshot: () => Promise<AgentToolsAdminSnapshot>
	replacePolicy: (
		expectedRevision: number,
		policy: AgentToolsPolicyInput,
	) => Promise<AgentToolsAdminSnapshot>
}

type RuntimeRpcApiContract = {
	ping: () => string
	packageManager: () => PackageManagerFeatureApi | null
	logging: () => LoggingHandleApi
	agentTools: () => AgentToolsHandleApi
	workbenchRpc: (grantId: string) => WorkbenchRpcView
	updatePluginGroups: (groups: PluginGroupInput[]) => Promise<PluginGroup[]>
	pluginSchema: (name: string) => Promise<SchemaResult>
	pluginConfig: (name: string) => Promise<ConfigResult>
	patchPluginConfig: (name: string, patch: Record<string, unknown>) => Promise<ConfigResult>
	patchPluginConfigField: (name: string, input: ConfigFieldMutation) => Promise<ConfigResult>
	pluginDependencies: (name: string) => Promise<PluginDependencyRef[]>
	inspectPluginDependencies: (name: string) => Promise<PluginDependencyState[]>
	setPluginDependencyTarget: (input: {
		name: string
		index: number
		targetName: string | null
	}) => Promise<PluginDependencyMutationResult>
	inspectPluginBaseProvider: (name: string) => Promise<BaseProviderInfo | null>
	selectPluginBaseProvider: (input: {
		name: string
		baseToken: string
		providerName: string | null
	}) => Promise<PluginDependencyMutationResult>
	ensurePluginFork: (input: {
		baseName: string
		forkId: string
		enable?: boolean
	}) => Promise<EnsureForkResult>
	applyPluginStatusActions: (actions: PluginStatusBatchAction[]) => Promise<PluginStatusBatchResult>
}

export type RuntimeRpcApi = RuntimeRpcApiContract

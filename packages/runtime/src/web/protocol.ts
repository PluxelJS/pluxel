/**
 * Runtime transport protocol types (client/server shared).
 *
 * Keep protocol contracts and UI extension augmentation in one place so
 * `@pluxel/runtime/web` can stay the canonical browser-facing type surface.
 */
import type { AgentToolsAdminSnapshot, AgentToolsPolicyInput } from '../agent-tools'
import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
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
	application: 'not-requested' | 'applied' | 'deferred' | 'saved-not-applied'
	applyError?: string
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
	fieldName: string
	schemaSource: string
	defaults: Record<string, unknown>
	sections: readonly {
		path: readonly string[]
		fieldName: string
		schemaSource: string
		defaults: Record<string, unknown>
	}[]
}

export type SchemaResultErr = {
	ok: false
	code: string
	message: string
}

export type SchemaResult = SchemaResultOk | SchemaResultErr

export type PluginStatusBatchAction = {
	address: PluginNodeAddress
	action: PluginStatusAction
}
export type PluginStatusMutationResult = {
	address: PluginNodeAddress
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

export type PluginDependencyKind = 'plugin' | 'abstract'

export type PluginGroupInput = {
	groupId: string
	name: string
	nodes: PluginNodeAddress[]
}

export type PluginGroup = {
	__typename?: 'PluginGroup'
	id: string
	groupId: string
	name: string
	nodes: Array<{
		__typename?: 'PluginGroupNode'
		id: string
		displayName: string
		rootExportName: string
		address: PluginNodeAddress
	}>
}

export type PluginDependencyOption = {
	address: PluginNodeAddress
	displayName: string
	isRunning: boolean
	isEnabled: boolean
}

export type PluginDependencyRef = {
	address: PluginNodeAddress
	displayName: string
	isRunning?: boolean
}

export type PluginDependencyState = {
	index: number
	token: PluginDefinitionAddress
	kind: PluginDependencyKind
	effective: PluginNodeAddress | null
	isRunning: boolean
	selected: PluginNodeAddress | null
	providerDefault: PluginNodeAddress | null
	options: PluginDependencyOption[]
}

export type PluginDependencyMutationResult = {
	ok: boolean
	code?: string
	error?: string
}

export type EnsureForkResult = {
	ok: boolean
	fork?: PluginNodeAddress
	code?: string
	error?: string
}

export type BaseProviderInfo = {
	token: PluginDefinitionAddress
	currentDefault: PluginNodeAddress | null
	isDefault: boolean
	providers: PluginDependencyOption[]
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal'
export type RuntimePluginLogLevel = LogLevel | 'off'

export type PluginLogPolicySnapshot = {
	version: 2
	defaultLevel: RuntimePluginLogLevel
	overrides: Array<{ owner: PluginNodeAddress; level: RuntimePluginLogLevel }>
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
		owner: PluginNodeAddress,
		level: RuntimePluginLogLevel,
	) => Promise<PluginLogPolicyMutationResult>
	clearPluginLevel: (
		expectedRevision: number,
		owner: PluginNodeAddress,
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
	logging: () => LoggingHandleApi
	agentTools: () => AgentToolsHandleApi
	workbenchRpc: (grantId: string) => WorkbenchRpcView
	updatePluginGroups: (groups: PluginGroupInput[]) => Promise<PluginGroup[]>
	pluginSchema: (owner: PluginNodeAddress) => Promise<SchemaResult>
	pluginConfig: (owner: PluginNodeAddress) => Promise<ConfigResult>
	patchPluginConfig: (
		owner: PluginNodeAddress,
		patch: Record<string, unknown>,
	) => Promise<ConfigResult>
	patchPluginConfigField: (
		owner: PluginNodeAddress,
		input: ConfigFieldMutation,
	) => Promise<ConfigResult>
	pluginDependencies: (owner: PluginNodeAddress) => Promise<PluginDependencyRef[]>
	inspectPluginDependencies: (owner: PluginNodeAddress) => Promise<PluginDependencyState[]>
	setPluginDependencyTarget: (input: {
		consumer: PluginNodeAddress
		index: number
		provider: PluginNodeAddress | null
	}) => Promise<PluginDependencyMutationResult>
	inspectPluginBaseProvider: (owner: PluginNodeAddress) => Promise<BaseProviderInfo | null>
	selectPluginBaseProvider: (input: {
		consumer: PluginNodeAddress
		token: PluginDefinitionAddress
		provider: PluginNodeAddress | null
	}) => Promise<PluginDependencyMutationResult>
	ensurePluginFork: (input: {
		base: PluginNodeAddress
		forkId: string
		enable?: boolean
	}) => Promise<EnsureForkResult>
	applyPluginStatusActions: (actions: PluginStatusBatchAction[]) => Promise<PluginStatusBatchResult>
}

export type RuntimeRpcApi = RuntimeRpcApiContract

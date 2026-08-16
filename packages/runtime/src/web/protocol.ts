/**
 * Runtime transport protocol types (client/server shared).
 *
 * Keep protocol contracts and UI extension augmentation in one place so
 * `@pluxel/runtime/web` can stay the canonical browser-facing type surface.
 */
import type { AgentToolsAdminSnapshot, AgentToolsPolicyInput } from '../agent-tools'
import type { PluginDefinitionAddressSnapshot, PluginNodeAddressSnapshot } from '@pluxel/core'
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
}

export type SchemaResultErr = {
	ok: false
	code: string
	message: string
}

export type SchemaResult = SchemaResultOk | SchemaResultErr

export type PluginStatusBatchAction = {
	address: PluginNodeAddressSnapshot
	action: PluginStatusAction
}
export type PluginStatusMutationResult = {
	address: PluginNodeAddressSnapshot
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
	nodes: PluginNodeAddressSnapshot[]
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
		address: PluginNodeAddressSnapshot
	}>
}

export type PluginDependencyOption = {
	address: PluginNodeAddressSnapshot
	displayName: string
	isRunning: boolean
	isEnabled: boolean
}

export type PluginDependencyRef = {
	address: PluginNodeAddressSnapshot
	displayName: string
	isRunning?: boolean
}

export type PluginDependencyState = {
	index: number
	token: PluginDefinitionAddressSnapshot
	kind: PluginDependencyKind
	effective: PluginNodeAddressSnapshot | null
	isRunning: boolean
	selected: PluginNodeAddressSnapshot | null
	providerDefault: PluginNodeAddressSnapshot | null
	options: PluginDependencyOption[]
}

export type PluginDependencyMutationResult = {
	ok: boolean
	code?: string
	error?: string
}

export type EnsureForkResult = {
	ok: boolean
	fork?: PluginNodeAddressSnapshot
	code?: string
	error?: string
}

export type BaseProviderInfo = {
	token: PluginDefinitionAddressSnapshot
	currentDefault: PluginNodeAddressSnapshot | null
	isDefault: boolean
	providers: PluginDependencyOption[]
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal'
export type RuntimePluginLogLevel = LogLevel | 'off'

export type PluginLogPolicySnapshot = {
	version: 2
	defaultLevel: RuntimePluginLogLevel
	overrides: Array<{ owner: PluginNodeAddressSnapshot; level: RuntimePluginLogLevel }>
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
		owner: PluginNodeAddressSnapshot,
		level: RuntimePluginLogLevel,
	) => Promise<PluginLogPolicyMutationResult>
	clearPluginLevel: (
		expectedRevision: number,
		owner: PluginNodeAddressSnapshot,
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
	pluginSchema: (owner: PluginNodeAddressSnapshot) => Promise<SchemaResult>
	pluginConfig: (owner: PluginNodeAddressSnapshot) => Promise<ConfigResult>
	patchPluginConfig: (
		owner: PluginNodeAddressSnapshot,
		patch: Record<string, unknown>,
	) => Promise<ConfigResult>
	patchPluginConfigField: (
		owner: PluginNodeAddressSnapshot,
		input: ConfigFieldMutation,
	) => Promise<ConfigResult>
	pluginDependencies: (owner: PluginNodeAddressSnapshot) => Promise<PluginDependencyRef[]>
	inspectPluginDependencies: (owner: PluginNodeAddressSnapshot) => Promise<PluginDependencyState[]>
	setPluginDependencyTarget: (input: {
		consumer: PluginNodeAddressSnapshot
		index: number
		provider: PluginNodeAddressSnapshot | null
	}) => Promise<PluginDependencyMutationResult>
	inspectPluginBaseProvider: (owner: PluginNodeAddressSnapshot) => Promise<BaseProviderInfo | null>
	selectPluginBaseProvider: (input: {
		consumer: PluginNodeAddressSnapshot
		token: PluginDefinitionAddressSnapshot
		provider: PluginNodeAddressSnapshot | null
	}) => Promise<PluginDependencyMutationResult>
	ensurePluginFork: (input: {
		base: PluginNodeAddressSnapshot
		forkId: string
		enable?: boolean
	}) => Promise<EnsureForkResult>
	applyPluginStatusActions: (actions: PluginStatusBatchAction[]) => Promise<PluginStatusBatchResult>
}

export type RuntimeRpcApi = RuntimeRpcApiContract

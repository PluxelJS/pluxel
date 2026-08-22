/**
 * Runtime transport protocol types (client/server shared).
 *
 * Keep protocol contracts and UI extension augmentation in one place so
 * `@pluxel/runtime/web` can stay the canonical browser-facing type surface.
 */
import type { AgentToolsAdminSnapshot, AgentToolsPolicyInput } from '../agent-tools'
import type {
	PluginDefinitionAddress,
	PluginLifecycleIssueKind,
	PluginLifecycleIssuePhase,
	PluginNodeAddress,
} from '@pluxel/core'
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

export type PluginStatusAction = 'enable' | 'disable' | 'restart'
export type ConfigPatch = Record<string, unknown>
export type ConfigFieldMutation = {
	fieldPath: string
	value: unknown
}
export type ConfigValidationErrors = Record<
	string,
	Record<string, { message: string; path: string[] }[]>
>

export type PluginReconciliationIssue =
	| Readonly<{
			kind: 'consumer_unavailable'
			consumer: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			kind: 'requirement_removed'
			binding: 'dependency-override'
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			kind: 'provider_unavailable' | 'provider_disabled' | 'provider_incompatible'
			binding: 'provider-default' | 'dependency-override'
			consumer?: PluginNodeAddress
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			kind: 'fork_not_allowed'
			node: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			kind: 'fork_default_forbidden' | 'provider_default_requires_abstract'
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			kind: 'explicit_binding_invalid'
			binding: 'provider-default' | 'dependency-override'
			consumer?: PluginNodeAddress
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress
			message: string
	  }>
	| Readonly<{
			kind: 'missing_required_provider'
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
			message: string
	  }>

export type PluginApplyLifecycleErrorInfo = Readonly<{
	name: string
	message: string
	stack?: string
	cause?: string
	partPath?: readonly string[]
}>

export type PluginApplyLifecycleIssue = Readonly<{
	plugin: PluginNodeAddress
	phase: PluginLifecycleIssuePhase
	kind: PluginLifecycleIssueKind
	message: string
	error?: PluginApplyLifecycleErrorInfo
	blockedBy?: PluginNodeAddress
}>

export type PluginApplyCommitSummary = Readonly<{
	pluginChanges: Readonly<{
		added: readonly PluginNodeAddress[]
		replaced: readonly Readonly<{ from: PluginNodeAddress; to: PluginNodeAddress }>[]
		removed: readonly PluginNodeAddress[]
		restarted: readonly PluginNodeAddress[]
		availabilityChanged: readonly PluginNodeAddress[]
	}>
	runtimeUpdate: Readonly<{ reason?: string }>
	lifecycleReport: Readonly<{
		ok: boolean
		issues: readonly PluginApplyLifecycleIssue[]
	}>
}>

/** Address-only control-plane report safe to serialize to browser and worker realms. */
export type PluginApplyReport = Readonly<{
	catalogRevision: number
	runtimeStateRevision: number
	reconciliation: readonly PluginReconciliationIssue[]
	core:
		| Readonly<{ status: 'unchanged' }>
		| Readonly<{ status: 'committed'; summary: PluginApplyCommitSummary }>
}>

type ConfigSnapshotResult = {
	config: Record<string, unknown>
	defaults: Record<string, unknown>
}

type ConfigValueResult = {
	config: Record<string, unknown>
}

export type ConfigResultOk =
	| (ConfigSnapshotResult & {
			ok: true
			saved: false
			application: 'not-requested'
	  })
	| (ConfigValueResult & {
			ok: true
			saved: true
			application: 'applied' | 'deferred'
			report: PluginApplyReport
	  })
	| (ConfigValueResult & {
			ok: true
			saved: true
			application: 'saved-not-applied'
			report: PluginApplyReport
			applyFailure: {
				code: 'plugin_not_running_after_restart'
				message: string
			}
	  })

export type ConfigResultErr =
	| {
			ok: false
			code: 'validation_failed'
			state: 'unchanged'
			message: string
			errors: ConfigValidationErrors
			defaults?: Record<string, unknown>
	  }
	| {
			ok: false
			code: 'invalid_input' | 'node_unavailable' | 'config_not_found' | 'mutation_rejected'
			state: 'unchanged'
			message: string
	  }
	| (ConfigValueResult & {
			ok: false
			code: 'persistence_failed'
			state: 'unknown'
			message: string
	  })

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
	code: 'invalid_input' | 'node_unavailable' | 'schema_not_found' | 'schema_source_missing'
	message: string
}

export type SchemaResult = SchemaResultOk | SchemaResultErr

export type PluginStatusBatchAction = {
	address: PluginNodeAddress
	action: PluginStatusAction
}
export type PluginStatusMutationErrorCode =
	| 'plugin_not_found'
	| 'restart_unavailable'
	| 'graph_rejected'
	| 'persistence_failed'
	| 'state_mutation_rejected'
export type PluginStatusMutationSuccess = {
	address: PluginNodeAddress
	ok: true
	status: 'applied'
	report: PluginApplyReport
	isRunning: boolean
	isEnabled: boolean
	lifecycleStage: PluginStatusEntryLifecycleStage
}
export type PluginStatusMutationFailure =
	| {
			address: PluginNodeAddress
			ok: false
			code:
				| 'plugin_not_found'
				| 'restart_unavailable'
				| 'graph_rejected'
				| 'state_mutation_rejected'
			state: 'unchanged'
			error: string
	  }
	| {
			address: PluginNodeAddress
			ok: false
			code: 'persistence_failed'
			state: 'unknown'
			error: string
	  }
export type PluginStatusMutationResult = PluginStatusMutationSuccess | PluginStatusMutationFailure
/** Actions are serialized and may partially apply before a later item fails. */
export type PluginStatusBatchResult =
	| { ok: true; status: 'applied'; results: PluginStatusMutationSuccess[] }
	| {
			ok: false
			status: 'partially-applied' | 'rejected'
			results: PluginStatusMutationResult[]
	  }
	| {
			ok: false
			status: 'rejected'
			code: 'invalid_input'
			state: 'unchanged'
			error: string
			results: []
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

export type PluginDependencyMutationErrorCode =
	| 'invalid_input'
	| 'invalid_index'
	| 'consumer_unavailable'
	| 'provider_unavailable'
	| 'not_forkable'
	| 'requirement_not_found'
	| 'provider_incompatible'
	| 'fork_default_forbidden'
	| 'provider_default_requires_abstract'
	| 'graph_rejected'
	| 'persistence_failed'
export type PluginDependencyMutationResult =
	| { ok: true; status: 'applied'; report: PluginApplyReport }
	| {
			ok: false
			code: Exclude<PluginDependencyMutationErrorCode, 'persistence_failed'>
			state: 'unchanged'
			error: string
	  }
	| {
			ok: false
			code: 'persistence_failed'
			state: 'unknown'
			error: string
	  }

export type PluginDependencyQueryFailure = {
	ok: false
	code: 'invalid_input' | 'consumer_unavailable'
	state: 'unchanged'
	error: string
}

export type PluginDependencyListResult =
	| { ok: true; items: PluginDependencyRef[] }
	| PluginDependencyQueryFailure

export type PluginDependencyInspectionResult =
	| { ok: true; items: PluginDependencyState[] }
	| PluginDependencyQueryFailure

export type EnsureForkResult =
	| {
			ok: true
			status: 'applied' | 'deferred'
			fork: PluginNodeAddress
			report: PluginApplyReport
	  }
	| {
			ok: true
			status: 'saved-not-applied'
			fork: PluginNodeAddress
			report: PluginApplyReport
			applicationFailure: {
				code: 'plugin_not_running_after_enable'
				message: string
			}
	  }
	| {
			ok: false
			code:
				| 'invalid_input'
				| 'invalid_fork_id'
				| 'definition_unavailable'
				| 'not_forkable'
				| 'consumer_unavailable'
				| 'provider_unavailable'
				| 'requirement_not_found'
				| 'provider_incompatible'
				| 'graph_rejected'
			state: 'unchanged'
			error: string
	  }
	| {
			ok: false
			code: 'persistence_failed'
			state: 'unknown'
			error: string
	  }

export type RemoveForkResult =
	| {
			ok: true
			status: 'removed' | 'removed-with-lifecycle-issues'
			fork: PluginNodeAddress
			report: PluginApplyReport
	  }
	| {
			ok: true
			status: 'already-absent'
			fork: PluginNodeAddress
	  }
	| {
			ok: false
			code: 'invalid_input' | 'invalid_fork_id' | 'graph_rejected'
			state: 'unchanged'
			error: string
	  }
	| {
			ok: false
			code: 'fork_referenced'
			state: 'unchanged'
			references: readonly Readonly<{
				consumer: PluginNodeAddress
				requirement: PluginDefinitionAddress
			}>[]
			error: string
	  }
	| {
			ok: false
			code: 'persistence_failed'
			state: 'retained' | 'disabled-retained' | 'unknown'
			fork: PluginNodeAddress
			report?: PluginApplyReport
			error: string
	  }

export type BaseProviderInfo = {
	token: PluginDefinitionAddress
	currentDefault: PluginNodeAddress | null
	isDefault: boolean
	providers: PluginDependencyOption[]
}

export type BaseProviderInspectionResult =
	| { ok: true; value: BaseProviderInfo | null }
	| PluginDependencyQueryFailure

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
	pluginDependencies: (owner: PluginNodeAddress) => Promise<PluginDependencyListResult>
	inspectPluginDependencies: (owner: PluginNodeAddress) => Promise<PluginDependencyInspectionResult>
	setPluginDependencyTarget: (input: {
		consumer: PluginNodeAddress
		index: number
		provider: PluginNodeAddress | null
	}) => Promise<PluginDependencyMutationResult>
	inspectPluginBaseProvider: (owner: PluginNodeAddress) => Promise<BaseProviderInspectionResult>
	selectPluginBaseProvider: (input: {
		consumer: PluginNodeAddress
		token: PluginDefinitionAddress
		provider: PluginNodeAddress | null
	}) => Promise<PluginDependencyMutationResult>
	ensurePluginFork: (input: {
		base: PluginNodeAddress
		forkId: string
		enable?: boolean
		selectFor?: {
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
		}
	}) => Promise<EnsureForkResult>
	removePluginFork: (input: {
		base: PluginNodeAddress
		forkId: string
	}) => Promise<RemoveForkResult>
	applyPluginStatusActions: (actions: PluginStatusBatchAction[]) => Promise<PluginStatusBatchResult>
}

export type RuntimeRpcApi = RuntimeRpcApiContract

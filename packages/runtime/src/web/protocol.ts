/** Versioned, framework-neutral management protocol types shared by clients and servers. */
import type { AgentToolsAdminSnapshot, AgentToolsPolicyInput } from '../agent-tools'
import type {
	PluginDefinitionAddress,
	PluginLifecycleIssueKind,
	PluginLifecycleIssuePhase,
	PluginNodeAddress,
} from '@pluxel/core'
import type { HostApplicationMeta } from '../product-contract'
export type { VaultKeyPair } from '../services/vault/types'
export type {
	AgentToolAssignment,
	AgentToolsAdminSnapshot,
	AgentToolsPolicy,
	AgentToolsPolicyInput,
	CommandInventoryItem,
	CommandToolset,
} from '../agent-tools'

export const RUNTIME_MANAGEMENT_PROTOCOL_MAJOR = 1 as const
export const RUNTIME_MANAGEMENT_CAPABILITIES = Object.freeze([
	'plugins.list',
	'plugins.status',
	'plugins.lifecycle',
	'plugins.config',
	'plugins.dependencies',
	'plugins.forks',
	'plugin-groups',
	'logging',
	'agent-tools',
	'security',
	'vault',
] as const)

export type RuntimeManagementCapability = (typeof RUNTIME_MANAGEMENT_CAPABILITIES)[number]

export type RuntimeMetaV1 = Readonly<{
	service: 'pluxel-runtime'
	ready: true
	protocol: Readonly<{
		name: 'pluxel.management'
		major: 1
		capabilities: readonly RuntimeManagementCapability[]
	}>
	application: HostApplicationMeta
	workbench: Readonly<{ enabled: boolean }>
}>

export type PluginSourceSnapshot =
	| Readonly<{
			kind: 'package'
			moduleId: string
			packageName: string
			version: string | null
			tag: string | null
	  }>
	| Readonly<{
			kind: 'hmr'
			moduleId: string
			packageName: null
			version: null
			tag: null
	  }>
	| Readonly<{
			kind: 'unknown'
			moduleId: null
			packageName: null
			version: null
			tag: null
	  }>

export type PluginStatusIssue = Readonly<{
	id: string
	code:
		| 'consumer_unavailable'
		| 'requirement_removed'
		| 'provider_unavailable'
		| 'provider_incompatible'
		| 'fork_not_allowed'
		| 'fork_default_forbidden'
		| 'provider_default_requires_abstract'
		| 'explicit_binding_invalid'
		| 'missing_required_provider'
		| 'definition_unavailable'
	message: string
}>

export type PluginControlSnapshot = Readonly<{
	autoStart: boolean
	sessionIntent: 'inherit' | 'run' | 'stop'
	desiredState: 'running' | 'stopped'
	activationReason: 'auto-start' | 'session' | 'dependency' | null
	lifecycleState: 'running' | 'stopped'
}>

export type PluginStatusSnapshot = PluginControlSnapshot &
	Readonly<{
		address: PluginNodeAddress
		reference: string
		route: string
		displayName: string
		label: Readonly<{ title: string; qualifier?: string; text: string }>
		rootExportName: string
		availability: 'available' | 'unavailable'
		issues: readonly PluginStatusIssue[]
		source: PluginSourceSnapshot
	}>

export type PluginsListOutput = Readonly<{
	plugins: readonly PluginStatusSnapshot[]
	summary: Readonly<{ total: number; running: number; stopped: number; autoStart: number }>
}>

export type PluginStatusQueryResult =
	| Readonly<{ ok: true; value: PluginStatusSnapshot | null }>
	| Readonly<{
			ok: false
			code: 'invalid_input'
			state: 'unchanged'
			error: string
	  }>

export type ConfigPatch = Record<string, unknown>
export type ConfigFieldMutation = Readonly<{
	fieldPath: string
	value: unknown
}>
export type ConfigValidationErrors = Readonly<
	Record<
		string,
		Readonly<Record<string, readonly Readonly<{ message: string; path: readonly string[] }>[]>>
	>
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
			kind: 'provider_unavailable' | 'provider_incompatible'
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

type ConfigSnapshotResult = Readonly<{
	config: Readonly<Record<string, unknown>>
	defaults: Readonly<Record<string, unknown>>
}>

type ConfigValueResult = Readonly<{ config: Readonly<Record<string, unknown>> }>

export type ConfigResultOk =
	| (ConfigSnapshotResult &
			Readonly<{
				ok: true
				saved: false
				application: 'applied' | 'deferred' | 'saved-not-applied'
				desiredRevision: number
				appliedRevision: number | null
			}>)
	| (ConfigValueResult &
			Readonly<{
				ok: true
				saved: true
				application: 'applied' | 'deferred'
				desiredRevision: number
				appliedRevision: number | null
				report: PluginApplyReport
			}>)
	| (ConfigValueResult &
			Readonly<{
				ok: true
				saved: true
				application: 'saved-not-applied'
				desiredRevision: number
				appliedRevision: number | null
				report: PluginApplyReport
				applyFailure: Readonly<{
					code: 'listener_not_registered' | 'listener_failed' | 'generation_changed'
					message: string
				}>
			}>)

export type ConfigResultErr =
	| Readonly<{
			ok: false
			code: 'validation_failed'
			state: 'unchanged'
			message: string
			errors: ConfigValidationErrors
			defaults?: Record<string, unknown>
	  }>
	| Readonly<{
			ok: false
			code: 'invalid_input' | 'node_unavailable' | 'config_not_found' | 'mutation_rejected'
			state: 'unchanged'
			message: string
	  }>
	| (ConfigValueResult & {
			ok: false
			code: 'persistence_failed'
			state: 'unknown'
			message: string
	  })

export type ConfigResult = ConfigResultOk | ConfigResultErr

export type RuntimeJsonValue =
	| null
	| string
	| number
	| boolean
	| readonly RuntimeJsonValue[]
	| { readonly [key: string]: RuntimeJsonValue }
export type RuntimeJsonObject = Readonly<{ [key: string]: RuntimeJsonValue }>

export type ConfigPresentationFieldMetaV1 = Readonly<{
	label: string
	description?: string
	help?: string
	hint?: string
	badge?: string | Readonly<{ label: string; color?: string }>
	section?: Readonly<{
		id: string
		title?: string
		description?: string
		order?: number
		columns?: number
	}>
	layout?: Readonly<{
		full?: boolean
		span?: number
		align?: 'start' | 'center' | 'end'
	}>
	hideLabel?: boolean
	hideRequired?: boolean
	disabled?: boolean
	readOnly?: boolean
	hidden?: boolean
}>

type ConfigPresentationFieldBaseV1 = Readonly<{
	name?: string
	path: string
	depth: number
	meta: ConfigPresentationFieldMetaV1
	required: boolean
}>

export type ConfigPresentationBranchFieldV1 = Readonly<{
	key: string
	node: ConfigPresentationFieldV1
	replaceValue?: boolean
}>

export type ConfigPresentationFieldV1 =
	| (ConfigPresentationFieldBaseV1 &
			Readonly<{
				kind: 'string'
				control: 'text' | 'textarea' | 'password' | 'code'
				placeholder?: string
				rows?: number
				minLength?: number
				maxLength?: number
				format?: string
			}>)
	| (ConfigPresentationFieldBaseV1 &
			Readonly<{
				kind: 'number'
				min?: number
				max?: number
				step?: number
				integer?: boolean
				placeholder?: string
			}>)
	| (ConfigPresentationFieldBaseV1 & Readonly<{ kind: 'boolean'; control: 'switch' }>)
	| (ConfigPresentationFieldBaseV1 &
			Readonly<{
				kind: 'picklist'
				control: 'select' | 'segmented' | 'radio'
				options?: readonly (string | number)[]
				entries?: readonly Readonly<{
					value: string | number
					label?: string
					description?: string
					group?: string
					disabled?: boolean
					accentColor?: string
				}>[]
				labels?: Readonly<Record<string, string>>
				disabled?: readonly (string | number)[]
				placeholder?: string
				searchable?: boolean
				clearable?: boolean
				max?: number
				create?: boolean
				emptyLabel?: string
			}>)
	| (ConfigPresentationFieldBaseV1 &
			Readonly<{
				kind: 'array'
				item?: ConfigPresentationFieldV1 | null
				layout?: 'list' | 'grid' | 'picker'
				columns?: number
				disableAutoGrid?: boolean
				min?: number
				max?: number
				addable?: boolean
				removable?: boolean
				reorderable?: boolean
				itemLabel?: string
				addLabel?: string
				emptyHint?: string
				defaultItem?: RuntimeJsonValue
			}>)
	| (ConfigPresentationFieldBaseV1 &
			Readonly<{
				kind: 'record'
				value?: ConfigPresentationFieldV1 | null
				layout?: 'table' | 'list'
				min?: number
				max?: number
				addable?: boolean
				removable?: boolean
				reorderable?: boolean
				editableKey?: boolean
				key?: Readonly<{ label?: string; placeholder?: string; width?: number | string }>
				valueMeta?: Readonly<{
					label?: string
					placeholder?: string
					width?: number | string
				}>
				addLabel?: string
				emptyHint?: string
			}>)
	| (ConfigPresentationFieldBaseV1 &
			Readonly<{
				kind: 'object'
				fields: readonly ConfigPresentationFieldV1[]
				variant?: 'card' | 'stack'
				columns?: number
				gap?: number | string
				collapsible?: boolean
				collapsed?: boolean
			}>)
	| (ConfigPresentationFieldBaseV1 &
			Readonly<{
				kind: 'union'
				branches: readonly Readonly<{
					key: string
					discriminatorValue?: string | number | boolean | null
					fields: readonly ConfigPresentationBranchFieldV1[]
				}>[]
				sharedFields: readonly ConfigPresentationBranchFieldV1[]
				discriminator?: string
				discriminatorField?: ConfigPresentationBranchFieldV1
				control: 'select' | 'segmented' | 'radio' | 'switch'
				labels?: Readonly<Record<string, string>>
				descriptions?: Readonly<Record<string, string>>
				placeholder?: string
				searchable?: boolean
				expose?: 'auto' | 'always' | 'never'
				preserve?: boolean
				compact?: boolean
			}>)
	| (ConfigPresentationFieldBaseV1 &
			Readonly<{
				kind: 'unsupported'
				readOnly: true
				reason: string
			}>)

export type ConfigPresentationPlanV1 = Readonly<{
	version: 1
	fieldName: string
	defaults: RuntimeJsonObject
	fields: readonly ConfigPresentationFieldV1[]
	sections: readonly Readonly<{
		path: readonly string[]
		fieldName: string
		defaults: RuntimeJsonObject
		fields: readonly ConfigPresentationFieldV1[]
	}>[]
}>

export type ConfigPresentationResultOk = Readonly<{
	ok: true
	plan: ConfigPresentationPlanV1
}>

export type ConfigPresentationResultErr = Readonly<{
	ok: false
	code: 'invalid_input' | 'node_unavailable' | 'presentation_not_found'
	message: string
}>

export type ConfigPresentationResult = ConfigPresentationResultOk | ConfigPresentationResultErr

export type PluginAutoStartBatchItem = Readonly<{
	address: PluginNodeAddress
	autoStart: boolean
}>

export type PluginLifecycleCommand = 'start' | 'stop' | 'restart'
export type PluginLifecycleCommandBatchItem = Readonly<{
	address: PluginNodeAddress
	command: PluginLifecycleCommand
}>

export type PluginControlMutationErrorCode =
	| 'plugin_not_found'
	| 'start_unavailable'
	| 'restart_unavailable'
	| 'node_unavailable'
	| 'graph_rejected'
	| 'persistence_failed'
export type PluginControlMutationSuccess = Readonly<{
	address: PluginNodeAddress
	ok: true
	status: 'applied'
	report: PluginApplyReport
	control: PluginControlSnapshot
}>
export type PluginControlMutationFailure =
	| Readonly<{
			address: PluginNodeAddress
			ok: false
			code:
				| 'plugin_not_found'
				| 'start_unavailable'
				| 'restart_unavailable'
				| 'node_unavailable'
				| 'graph_rejected'
			state: 'unchanged'
			error: string
	  }>
	| Readonly<{
			address: PluginNodeAddress
			ok: false
			code: 'persistence_failed'
			state: 'unknown'
			error: string
	  }>
export type PluginControlMutationResult =
	| PluginControlMutationSuccess
	| PluginControlMutationFailure
/** Actions are serialized and may partially apply before a later item fails. */
export type PluginControlBatchResult =
	| Readonly<{ ok: true; status: 'applied'; results: readonly PluginControlMutationSuccess[] }>
	| Readonly<{
			ok: false
			status: 'partially-applied' | 'rejected'
			results: readonly PluginControlMutationResult[]
	  }>
	| Readonly<{
			ok: false
			status: 'rejected'
			code: 'invalid_input'
			state: 'unchanged'
			error: string
			results: readonly []
	  }>
export type PluginDependencyKind = 'plugin' | 'abstract'

export type PluginGroupInput = {
	groupId: string
	name: string
	nodes: readonly PluginNodeAddress[]
}

export type PluginGroup = Readonly<{
	groupId: string
	name: string
	nodes: readonly Readonly<{
		reference: string
		route: string
		displayName: string
		label: string
		rootExportName: string
		address: PluginNodeAddress
	}>[]
}>

export type PluginGroupsMutationResult =
	| Readonly<{ ok: true; groups: readonly PluginGroup[] }>
	| Readonly<{
			ok: false
			code: 'invalid_input' | 'mutation_rejected'
			state: 'unchanged'
			error: string
	  }>
	| Readonly<{
			ok: false
			code: 'persistence_failed'
			state: 'unknown'
			error: string
	  }>

export type PluginDependencyGraphSnapshot = Readonly<{
	nodes: readonly PluginDependencyGraphNode[]
	edges: readonly PluginDependencyGraphEdge[]
}>

export type PluginDependencyGraphNode = Readonly<{
	status: PluginStatusSnapshot
	effective: boolean
}>

type PluginDependencyGraphEdgeIdentity = Readonly<{
	consumer: PluginNodeAddress
	requirement: PluginDefinitionAddress
}>

export type PluginDependencyGraphEdge = PluginDependencyGraphEdgeIdentity &
	(
		| Readonly<{
				mode: 'required'
				resolution: Readonly<{
					state: 'resolved'
					provider: PluginNodeAddress
					via: 'direct' | 'provider-default' | 'dependency-override'
				}>
				effective: boolean
		  }>
		| Readonly<{
				mode: 'required'
				resolution: Readonly<{ state: 'unresolved' }>
				effective: false
		  }>
		| Readonly<{
				mode: 'optional'
				resolution: Readonly<{
					state: 'resolved'
					provider: PluginNodeAddress
					via: 'direct'
				}>
				effective: boolean
		  }>
	)

export type PluginProviderOption = Readonly<{
	address: PluginNodeAddress
	displayName: string
	availability: 'available' | 'unavailable'
}>

export type PluginConsumerRequirementState = Readonly<{
	requirement: PluginDefinitionAddress
	kind: PluginDependencyKind
	consumerOverride: PluginNodeAddress | null
	inheritedProvider: PluginNodeAddress | null
	options: readonly PluginProviderOption[]
}>

export type PluginDependencyMutationErrorCode =
	| 'invalid_input'
	| 'consumer_unavailable'
	| 'provider_unavailable'
	| 'not_forkable'
	| 'requirement_not_found'
	| 'provider_incompatible'
	| 'fork_default_forbidden'
	| 'provider_default_requires_abstract'
	| 'provider_policy_unavailable'
	| 'graph_rejected'
	| 'persistence_failed'
export type PluginDependencyMutationResult =
	| Readonly<{ ok: true; status: 'applied'; report: PluginApplyReport }>
	| Readonly<{
			ok: false
			code: Exclude<PluginDependencyMutationErrorCode, 'persistence_failed'>
			state: 'unchanged'
			error: string
	  }>
	| Readonly<{
			ok: false
			code: 'persistence_failed'
			state: 'unknown'
			error: string
	  }>

export type PluginConsumerRequirementsQueryFailure = Readonly<{
	ok: false
	code: 'invalid_input' | 'consumer_unavailable'
	state: 'unchanged'
	error: string
}>

export type PluginConsumerRequirementsInspectionResult =
	| Readonly<{ ok: true; items: readonly PluginConsumerRequirementState[] }>
	| PluginConsumerRequirementsQueryFailure

export type EnsureForkResult =
	| Readonly<{
			ok: true
			status: 'applied' | 'deferred'
			fork: PluginNodeAddress
			report: PluginApplyReport
	  }>
	| Readonly<{
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
	  }>
	| Readonly<{
			ok: false
			code: 'persistence_failed'
			state: 'unknown'
			error: string
	  }>

export type RemoveForkResult =
	| Readonly<{
			ok: true
			status: 'removed' | 'removed-with-lifecycle-issues'
			fork: PluginNodeAddress
			report: PluginApplyReport
	  }>
	| Readonly<{
			ok: true
			status: 'already-absent'
			fork: PluginNodeAddress
	  }>
	| Readonly<
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
	  >
	| Readonly<{
			ok: false
			code: 'persistence_failed'
			state: 'retained' | 'stopped-retained' | 'unknown'
			fork: PluginNodeAddress
			report?: PluginApplyReport
			error: string
	  }>

export type PluginProviderPolicyInfo = Readonly<{
	token: PluginDefinitionAddress
	defaultProvider: PluginNodeAddress | null
	policyOwnerIsDefault: boolean
	options: readonly PluginProviderOption[]
}>

export type PluginProviderPolicyInspectionResult =
	| Readonly<{ ok: true; value: PluginProviderPolicyInfo | null }>
	| Readonly<{
			ok: false
			code: 'invalid_input' | 'provider_policy_unavailable'
			state: 'unchanged'
			error: string
	  }>

export type LogLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal'
export type RuntimePluginLogLevel = LogLevel | 'off'

export type PluginLogPolicySnapshot = Readonly<{
	version: 3
	defaultLevel: RuntimePluginLogLevel
	overrides: readonly Readonly<{ owner: PluginNodeAddress; level: RuntimePluginLogLevel }>[]
}>

export type VersionedPluginLogPolicySnapshot = PluginLogPolicySnapshot &
	Readonly<{
		revision: number
		persistence: 'none' | 'clean' | 'dirty' | 'failed'
	}>

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

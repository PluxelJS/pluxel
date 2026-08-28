import {
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type {
	AgentToolAssignment,
	AgentToolsAdminSnapshot,
	AgentToolsPolicy,
	CommandInventoryItem,
	CommandToolset,
} from '../agent-tools'
import type {
	AdminAccessOverview,
	RuntimeSecurityClient,
	SecurityAuditEvent,
	SecurityOverview,
	VaultAdminState,
} from './security'
import type { LogRangeResult, LogStreamMeta, RuntimeLogError, RuntimeLogLine } from './logs'
import type {
	BaseProviderInfo,
	BaseProviderInspectionResult,
	ConfigPresentationResult,
	ConfigResult,
	ConfigValidationErrors,
	EnsureForkResult,
	PluginApplyCommitSummary,
	PluginApplyLifecycleErrorInfo,
	PluginApplyLifecycleIssue,
	PluginApplyReport,
	PluginDependencyInspectionResult,
	PluginDependencyListResult,
	PluginDependencyMutationResult,
	PluginDependencyOption,
	PluginDependencyRef,
	PluginDependencyState,
	PluginGroup,
	PluginGroupsMutationResult,
	PluginLogPolicyMutationResult,
	PluginReconciliationIssue,
	PluginsListOutput,
	PluginStatusBatchResult,
	PluginStatusIssue,
	PluginStatusMutationFailure,
	PluginStatusMutationResult,
	PluginStatusMutationSuccess,
	PluginStatusQueryResult,
	PluginStatusSnapshot,
	RemoveForkResult,
	RuntimeJsonObject,
	RuntimeJsonValue,
	RuntimePluginLogLevel,
	VersionedPluginLogPolicySnapshot,
} from './protocol'
import {
	parseConfigPresentationPlanV1,
	parseRuntimePortableData,
	RuntimeProtocolValidationError,
} from './validation'

const DANGEROUS_FIELDS = new Set(['__proto__', 'prototype', 'constructor'])
const LIFECYCLE_PHASES = ['resolve', 'config', 'start', 'dependency', 'drain'] as const
const LIFECYCLE_KINDS = [
	'resolve-failed',
	'config-failed',
	'start-failed',
	'dependency-blocked',
	'drain-failed',
] as const
const LOG_LEVELS = ['trace', 'debug', 'info', 'warning', 'error', 'fatal'] as const
const RUNTIME_LOG_LEVELS = [...LOG_LEVELS, 'off'] as const

/** Validate and deep-freeze the Plugin catalog returned by the management RPC boundary. */
export function parsePluginsListOutput(input: unknown): PluginsListOutput {
	const value = rootRecord(input, 'plugins list')
	shape(value, ['plugins', 'summary'], [], 'plugins list')
	const plugins = array(value.plugins, 'plugins list.plugins').map((item, index) =>
		pluginStatusSnapshot(item, `plugins list.plugins[${index}]`),
	)
	const summary = object(value.summary, 'plugins list.summary')
	shape(summary, ['total', 'running', 'stopped', 'disabled'], [], 'plugins list.summary')
	const total = nonNegativeInteger(summary.total, 'plugins list.summary.total')
	const running = nonNegativeInteger(summary.running, 'plugins list.summary.running')
	const stopped = nonNegativeInteger(summary.stopped, 'plugins list.summary.stopped')
	const disabled = nonNegativeInteger(summary.disabled, 'plugins list.summary.disabled')
	if (total !== plugins.length || running + stopped + disabled !== total) {
		fail('plugins list.summary is inconsistent with the catalog snapshot')
	}
	return Object.freeze({
		plugins: Object.freeze(plugins),
		summary: Object.freeze({ total, running, stopped, disabled }),
	})
}

/** Validate and deep-freeze one Plugin status query result. */
export function parsePluginStatusQueryResult(input: unknown): PluginStatusQueryResult {
	const value = rootRecord(input, 'plugin status result')
	if (value.ok === true) {
		shape(value, ['ok', 'value'], [], 'plugin status result')
		return Object.freeze({
			ok: true,
			value:
				value.value === null
					? null
					: pluginStatusSnapshot(value.value, 'plugin status result.value'),
		})
	}
	if (value.ok === false) {
		shape(value, ['ok', 'code', 'state', 'error'], [], 'plugin status result')
		literal(value.code, ['invalid_input'], 'plugin status result.code')
		literal(value.state, ['unchanged'], 'plugin status result.state')
		return Object.freeze({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
			error: text(value.error, 'plugin status result.error'),
		})
	}
	fail('plugin status result.ok must be boolean')
}

/** Validate and deep-freeze the host-owned Plugin groups snapshot. */
export function parsePluginGroups(input: unknown): readonly PluginGroup[] {
	const value = rootArray(input, 'plugin groups')
	return Object.freeze(value.map((item, index) => pluginGroup(item, `plugin groups[${index}]`)))
}

/** Validate and deep-freeze a Plugin groups mutation result. */
export function parsePluginGroupsMutationResult(input: unknown): PluginGroupsMutationResult {
	const value = rootRecord(input, 'plugin groups mutation result')
	if (value.ok === true) {
		shape(value, ['ok', 'groups'], [], 'plugin groups mutation result')
		return Object.freeze({
			ok: true,
			groups: Object.freeze(
				array(value.groups, 'plugin groups mutation result.groups').map((item, index) =>
					pluginGroup(item, `plugin groups mutation result.groups[${index}]`),
				),
			),
		})
	}
	if (value.ok !== false) fail('plugin groups mutation result.ok must be boolean')
	shape(value, ['ok', 'code', 'state', 'error'], [], 'plugin groups mutation result')
	const code = literal(
		value.code,
		['invalid_input', 'mutation_rejected', 'persistence_failed'],
		'plugin groups mutation result.code',
	)
	const state = literal(
		value.state,
		code === 'persistence_failed' ? ['unknown'] : ['unchanged'],
		'plugin groups mutation result.state',
	)
	return Object.freeze({
		ok: false,
		code,
		state,
		error: text(value.error, 'plugin groups mutation result.error'),
	}) as PluginGroupsMutationResult
}

/** Validate and deep-freeze config query and mutation results. */
export function parseConfigResult(input: unknown): ConfigResult {
	const value = rootRecord(input, 'config result')
	if (value.ok === true) return configSuccess(value)
	if (value.ok === false) return configFailure(value)
	fail('config result.ok must be boolean')
}

/** Validate and deep-freeze a config presentation query result. */
export function parseConfigPresentationResult(input: unknown): ConfigPresentationResult {
	const value = rootRecord(input, 'config presentation result')
	if (value.ok === true) {
		shape(value, ['ok', 'plan'], [], 'config presentation result')
		return Object.freeze({
			ok: true,
			plan: parseConfigPresentationPlanV1(value.plan),
		})
	}
	if (value.ok !== false) fail('config presentation result.ok must be boolean')
	shape(value, ['ok', 'code', 'message'], [], 'config presentation result')
	return Object.freeze({
		ok: false,
		code: literal(
			value.code,
			['invalid_input', 'node_unavailable', 'presentation_not_found'],
			'config presentation result.code',
		),
		message: text(value.message, 'config presentation result.message'),
	})
}

/** Validate and deep-freeze a dependency list result. */
export function parsePluginDependencyListResult(input: unknown): PluginDependencyListResult {
	const value = rootRecord(input, 'dependency list result')
	if (value.ok === true) {
		shape(value, ['ok', 'items'], [], 'dependency list result')
		return Object.freeze({
			ok: true,
			items: Object.freeze(
				array(value.items, 'dependency list result.items').map((item, index) =>
					dependencyRef(item, `dependency list result.items[${index}]`),
				),
			) as PluginDependencyRef[],
		})
	}
	return dependencyQueryFailure(value, 'dependency list result')
}

/** Validate and deep-freeze a dependency inspection result. */
export function parsePluginDependencyInspectionResult(
	input: unknown,
): PluginDependencyInspectionResult {
	const value = rootRecord(input, 'dependency inspection result')
	if (value.ok === true) {
		shape(value, ['ok', 'items'], [], 'dependency inspection result')
		return Object.freeze({
			ok: true,
			items: Object.freeze(
				array(value.items, 'dependency inspection result.items').map((item, index) =>
					dependencyState(item, `dependency inspection result.items[${index}]`),
				),
			) as PluginDependencyState[],
		})
	}
	return dependencyQueryFailure(value, 'dependency inspection result')
}

/** Validate and deep-freeze a dependency/provider mutation result. */
export function parsePluginDependencyMutationResult(
	input: unknown,
): PluginDependencyMutationResult {
	const value = rootRecord(input, 'dependency mutation result')
	if (value.ok === true) {
		shape(value, ['ok', 'status', 'report'], [], 'dependency mutation result')
		literal(value.status, ['applied'], 'dependency mutation result.status')
		return Object.freeze({
			ok: true,
			status: 'applied',
			report: pluginApplyReport(value.report, 'dependency mutation result.report'),
		})
	}
	if (value.ok !== false) fail('dependency mutation result.ok must be boolean')
	shape(value, ['ok', 'code', 'state', 'error'], [], 'dependency mutation result')
	const code = literal(
		value.code,
		[
			'invalid_input',
			'consumer_unavailable',
			'provider_unavailable',
			'not_forkable',
			'requirement_not_found',
			'provider_incompatible',
			'fork_default_forbidden',
			'provider_default_requires_abstract',
			'graph_rejected',
			'persistence_failed',
		],
		'dependency mutation result.code',
	)
	const state = literal(
		value.state,
		code === 'persistence_failed' ? ['unknown'] : ['unchanged'],
		'dependency mutation result.state',
	)
	return Object.freeze({
		ok: false,
		code,
		state,
		error: text(value.error, 'dependency mutation result.error'),
	}) as PluginDependencyMutationResult
}

/** Validate and deep-freeze a base-provider inspection result. */
export function parseBaseProviderInspectionResult(input: unknown): BaseProviderInspectionResult {
	const value = rootRecord(input, 'base provider inspection result')
	if (value.ok === true) {
		shape(value, ['ok', 'value'], [], 'base provider inspection result')
		return Object.freeze({
			ok: true,
			value:
				value.value === null
					? null
					: baseProviderInfo(value.value, 'base provider inspection result.value'),
		})
	}
	return dependencyQueryFailure(value, 'base provider inspection result')
}

/** Validate and deep-freeze a fork creation/update result. */
export function parseEnsureForkResult(input: unknown): EnsureForkResult {
	const value = rootRecord(input, 'ensure fork result')
	if (value.ok === true) {
		const status = literal(
			value.status,
			['applied', 'deferred', 'saved-not-applied'],
			'ensure fork result.status',
		)
		shape(
			value,
			['ok', 'status', 'fork', 'report'],
			status === 'saved-not-applied' ? ['applicationFailure'] : [],
			'ensure fork result',
		)
		const common = {
			ok: true as const,
			status,
			fork: nodeAddress(value.fork, 'ensure fork result.fork'),
			report: pluginApplyReport(value.report, 'ensure fork result.report'),
		}
		if (status !== 'saved-not-applied') {
			return Object.freeze({
				...common,
				status: status as 'applied' | 'deferred',
			})
		}
		if (value.applicationFailure === undefined) {
			fail('ensure fork result.applicationFailure is required for saved-not-applied')
		}
		const applicationFailure = object(
			value.applicationFailure,
			'ensure fork result.applicationFailure',
		)
		shape(applicationFailure, ['code', 'message'], [], 'ensure fork result.applicationFailure')
		literal(
			applicationFailure.code,
			['plugin_not_running_after_enable'],
			'ensure fork result.applicationFailure.code',
		)
		return Object.freeze({
			...common,
			status: 'saved-not-applied' as const,
			applicationFailure: Object.freeze({
				code: 'plugin_not_running_after_enable' as const,
				message: text(applicationFailure.message, 'ensure fork result.applicationFailure.message'),
			}),
		})
	}
	if (value.ok !== false) fail('ensure fork result.ok must be boolean')
	shape(value, ['ok', 'code', 'state', 'error'], [], 'ensure fork result')
	const code = literal(
		value.code,
		[
			'invalid_input',
			'invalid_fork_id',
			'definition_unavailable',
			'not_forkable',
			'consumer_unavailable',
			'provider_unavailable',
			'requirement_not_found',
			'provider_incompatible',
			'graph_rejected',
			'persistence_failed',
		],
		'ensure fork result.code',
	)
	const state = literal(
		value.state,
		code === 'persistence_failed' ? ['unknown'] : ['unchanged'],
		'ensure fork result.state',
	)
	return Object.freeze({
		ok: false,
		code,
		state,
		error: text(value.error, 'ensure fork result.error'),
	}) as EnsureForkResult
}

/** Validate and deep-freeze a fork removal result. */
export function parseRemoveForkResult(input: unknown): RemoveForkResult {
	const value = rootRecord(input, 'remove fork result')
	if (value.ok === true) return removeForkSuccess(value)
	if (value.ok === false) return removeForkFailure(value)
	fail('remove fork result.ok must be boolean')
}

/** Validate and deep-freeze a status batch result, including partial application. */
export function parsePluginStatusBatchResult(input: unknown): PluginStatusBatchResult {
	const value = rootRecord(input, 'plugin status batch result')
	if (value.ok === true) {
		shape(value, ['ok', 'status', 'results'], [], 'plugin status batch result')
		literal(value.status, ['applied'], 'plugin status batch result.status')
		const results = array(value.results, 'plugin status batch result.results').map((item, index) =>
			statusMutationSuccess(item, `plugin status batch result.results[${index}]`),
		)
		return Object.freeze({
			ok: true,
			status: 'applied',
			results: Object.freeze(results) as PluginStatusMutationSuccess[],
		})
	}
	if (value.ok !== false) fail('plugin status batch result.ok must be boolean')
	const status = literal(
		value.status,
		['partially-applied', 'rejected'],
		'plugin status batch result.status',
	)
	if (Object.hasOwn(value, 'code')) {
		shape(
			value,
			['ok', 'status', 'code', 'state', 'error', 'results'],
			[],
			'plugin status batch result',
		)
		if (status !== 'rejected') {
			fail('plugin status batch result with code must have rejected status')
		}
		literal(value.code, ['invalid_input'], 'plugin status batch result.code')
		literal(value.state, ['unchanged'], 'plugin status batch result.state')
		if (array(value.results, 'plugin status batch result.results').length > 0) {
			fail('plugin status batch invalid-input result must have an empty results array')
		}
		return Object.freeze({
			ok: false,
			status: 'rejected',
			code: 'invalid_input',
			state: 'unchanged',
			error: text(value.error, 'plugin status batch result.error'),
			results: Object.freeze([]) as [],
		})
	}
	shape(value, ['ok', 'status', 'results'], [], 'plugin status batch result')
	const results = array(value.results, 'plugin status batch result.results').map((item, index) =>
		statusMutationResult(item, `plugin status batch result.results[${index}]`),
	)
	if (status === 'partially-applied') {
		if (!results.some((result) => result.ok) || !results.some((result) => !result.ok)) {
			fail('partially-applied status batch must contain successes and failures')
		}
	} else if (results.some((result) => result.ok)) {
		fail('rejected status batch must not contain successful results')
	}
	return Object.freeze({
		ok: false,
		status,
		results: Object.freeze(results) as PluginStatusMutationResult[],
	}) as PluginStatusBatchResult
}

/** Validate and deep-freeze the current logging policy snapshot. */
export function parseVersionedPluginLogPolicySnapshot(
	input: unknown,
): VersionedPluginLogPolicySnapshot {
	const value = rootRecord(input, 'logging policy snapshot')
	shape(
		value,
		['version', 'defaultLevel', 'overrides', 'revision', 'persistence'],
		[],
		'logging policy snapshot',
	)
	if (value.version !== 2) fail('logging policy snapshot.version must be 2')
	return Object.freeze({
		version: 2,
		defaultLevel: runtimeLogLevel(value.defaultLevel, 'logging policy snapshot.defaultLevel'),
		overrides: Object.freeze(
			array(value.overrides, 'logging policy snapshot.overrides').map((item, index) => {
				const label = `logging policy snapshot.overrides[${index}]`
				const override = object(item, label)
				shape(override, ['owner', 'level'], [], label)
				return Object.freeze({
					owner: nodeAddress(override.owner, `${label}.owner`),
					level: runtimeLogLevel(override.level, `${label}.level`),
				})
			}),
		) as Array<{ owner: PluginNodeAddress; level: RuntimePluginLogLevel }>,
		revision: nonNegativeInteger(value.revision, 'logging policy snapshot.revision'),
		persistence: literal(
			value.persistence,
			['none', 'clean', 'dirty', 'failed'],
			'logging policy snapshot.persistence',
		),
	})
}

/** Validate and deep-freeze the compact result returned by logging mutations. */
export function parsePluginLogPolicyMutationResult(input: unknown): PluginLogPolicyMutationResult {
	const value = rootRecord(input, 'logging policy mutation result')
	shape(value, ['revision', 'persistence'], [], 'logging policy mutation result')
	return Object.freeze({
		revision: nonNegativeInteger(value.revision, 'logging policy mutation result.revision'),
		persistence: literal(
			value.persistence,
			['none', 'clean', 'dirty', 'failed'],
			'logging policy mutation result.persistence',
		),
	})
}

/** Validate and deep-freeze the Agent tools administration snapshot. */
export function parseAgentToolsAdminSnapshot(input: unknown): AgentToolsAdminSnapshot {
	const value = rootRecord(input, 'agent tools snapshot')
	shape(
		value,
		['revision', 'catalogRevision', 'persistence', 'writable', 'commands', 'policy'],
		['loadError'],
		'agent tools snapshot',
	)
	return Object.freeze({
		revision: nonNegativeInteger(value.revision, 'agent tools snapshot.revision'),
		catalogRevision: nonNegativeInteger(
			value.catalogRevision,
			'agent tools snapshot.catalogRevision',
		),
		persistence: literal(
			value.persistence,
			['durable', 'ephemeral', 'readonly'],
			'agent tools snapshot.persistence',
		),
		writable: boolean(value.writable, 'agent tools snapshot.writable'),
		...(value.loadError === undefined
			? {}
			: { loadError: text(value.loadError, 'agent tools snapshot.loadError') }),
		commands: Object.freeze(
			array(value.commands, 'agent tools snapshot.commands').map((item, index) =>
				commandInventoryItem(item, `agent tools snapshot.commands[${index}]`),
			),
		),
		policy: agentToolsPolicy(value.policy, 'agent tools snapshot.policy'),
	})
}

function pluginStatusSnapshot(input: unknown, label: string): PluginStatusSnapshot {
	const value = object(input, label)
	shape(
		value,
		[
			'address',
			'reference',
			'route',
			'displayName',
			'label',
			'rootExportName',
			'isRunning',
			'isEnabled',
			'lifecycleStage',
			'availability',
			'issues',
			'source',
		],
		[],
		label,
	)
	const projectedLabel = object(value.label, `${label}.label`)
	shape(projectedLabel, ['title', 'text'], ['qualifier'], `${label}.label`)
	const lifecycleStage = literal(
		value.lifecycleStage,
		['running', 'stopped', 'disabled'],
		`${label}.lifecycleStage`,
	)
	const isRunning = boolean(value.isRunning, `${label}.isRunning`)
	const isEnabled = boolean(value.isEnabled, `${label}.isEnabled`)
	if (isRunning !== (lifecycleStage === 'running')) {
		fail(`${label}.isRunning is inconsistent with lifecycleStage`)
	}
	if (isEnabled !== (lifecycleStage !== 'disabled')) {
		fail(`${label}.isEnabled is inconsistent with lifecycleStage`)
	}
	return Object.freeze({
		address: nodeAddress(value.address, `${label}.address`),
		reference: text(value.reference, `${label}.reference`),
		route: text(value.route, `${label}.route`),
		displayName: text(value.displayName, `${label}.displayName`),
		label: Object.freeze({
			title: text(projectedLabel.title, `${label}.label.title`),
			...(projectedLabel.qualifier === undefined
				? {}
				: { qualifier: text(projectedLabel.qualifier, `${label}.label.qualifier`) }),
			text: text(projectedLabel.text, `${label}.label.text`),
		}),
		rootExportName: text(value.rootExportName, `${label}.rootExportName`),
		isRunning,
		isEnabled,
		lifecycleStage,
		availability: literal(
			value.availability,
			['available', 'unavailable'],
			`${label}.availability`,
		),
		issues: Object.freeze(
			array(value.issues, `${label}.issues`).map((item, index) =>
				pluginStatusIssue(item, `${label}.issues[${index}]`),
			),
		),
		source: pluginSourceSnapshot(value.source, `${label}.source`),
	})
}

function pluginStatusIssue(input: unknown, label: string): PluginStatusIssue {
	const value = object(input, label)
	shape(value, ['id', 'code', 'message'], [], label)
	return Object.freeze({
		id: text(value.id, `${label}.id`),
		code: literal(
			value.code,
			[
				'consumer_unavailable',
				'requirement_removed',
				'provider_unavailable',
				'provider_disabled',
				'provider_incompatible',
				'fork_not_allowed',
				'fork_default_forbidden',
				'provider_default_requires_abstract',
				'explicit_binding_invalid',
				'missing_required_provider',
				'definition_unavailable',
			],
			`${label}.code`,
		),
		message: text(value.message, `${label}.message`),
	})
}

function pluginSourceSnapshot(input: unknown, label: string): PluginStatusSnapshot['source'] {
	const value = object(input, label)
	const kind = literal(value.kind, ['package', 'hmr', 'unknown'], `${label}.kind`)
	shape(value, ['kind', 'moduleId', 'packageName', 'version', 'tag'], [], label)
	if (kind === 'package') {
		return Object.freeze({
			kind,
			moduleId: text(value.moduleId, `${label}.moduleId`),
			packageName: text(value.packageName, `${label}.packageName`),
			version: nullableText(value.version, `${label}.version`),
			tag: nullableText(value.tag, `${label}.tag`),
		})
	}
	if (kind === 'hmr') {
		if (value.packageName !== null || value.version !== null || value.tag !== null) {
			fail(`${label} hmr source must have null packageName, version, and tag`)
		}
		return Object.freeze({
			kind,
			moduleId: text(value.moduleId, `${label}.moduleId`),
			packageName: null,
			version: null,
			tag: null,
		})
	}
	if (
		value.moduleId !== null ||
		value.packageName !== null ||
		value.version !== null ||
		value.tag !== null
	) {
		fail(`${label} unknown source must contain only null source fields`)
	}
	return Object.freeze({
		kind,
		moduleId: null,
		packageName: null,
		version: null,
		tag: null,
	})
}

function pluginGroup(input: unknown, label: string): PluginGroup {
	const value = object(input, label)
	shape(value, ['groupId', 'name', 'nodes'], [], label)
	return Object.freeze({
		groupId: text(value.groupId, `${label}.groupId`),
		name: text(value.name, `${label}.name`),
		nodes: Object.freeze(
			array(value.nodes, `${label}.nodes`).map((item, index) => {
				const nodeLabel = `${label}.nodes[${index}]`
				const node = object(item, nodeLabel)
				shape(
					node,
					['reference', 'route', 'displayName', 'label', 'rootExportName', 'address'],
					[],
					nodeLabel,
				)
				return Object.freeze({
					reference: text(node.reference, `${nodeLabel}.reference`),
					route: text(node.route, `${nodeLabel}.route`),
					displayName: text(node.displayName, `${nodeLabel}.displayName`),
					label: text(node.label, `${nodeLabel}.label`),
					rootExportName: text(node.rootExportName, `${nodeLabel}.rootExportName`),
					address: nodeAddress(node.address, `${nodeLabel}.address`),
				})
			}),
		),
	})
}

function configSuccess(value: Record<string, unknown>): ConfigResult {
	const saved = boolean(value.saved, 'config result.saved')
	const application = literal(
		value.application,
		['applied', 'deferred', 'saved-not-applied'],
		'config result.application',
	)
	const desiredRevision = nonNegativeInteger(value.desiredRevision, 'config result.desiredRevision')
	const appliedRevision = nullableNonNegativeInteger(
		value.appliedRevision,
		'config result.appliedRevision',
	)
	const config = portableRecord(value.config, 'config result.config')
	if (!saved) {
		shape(
			value,
			['ok', 'saved', 'application', 'desiredRevision', 'appliedRevision', 'config', 'defaults'],
			[],
			'config result',
		)
		return Object.freeze({
			ok: true,
			saved: false,
			application,
			desiredRevision,
			appliedRevision,
			config,
			defaults: portableRecord(value.defaults, 'config result.defaults'),
		})
	}
	shape(
		value,
		['ok', 'saved', 'application', 'desiredRevision', 'appliedRevision', 'config', 'report'],
		application === 'saved-not-applied' ? ['applyFailure'] : [],
		'config result',
	)
	const report = pluginApplyReport(value.report, 'config result.report')
	if (application !== 'saved-not-applied') {
		if (value.applyFailure !== undefined) {
			fail('config result.applyFailure is only valid for saved-not-applied')
		}
		return Object.freeze({
			ok: true,
			saved: true,
			application,
			desiredRevision,
			appliedRevision,
			config,
			report,
		})
	}
	if (value.applyFailure === undefined) {
		fail('config result.applyFailure is required for saved-not-applied')
	}
	const failure = object(value.applyFailure, 'config result.applyFailure')
	shape(failure, ['code', 'message'], [], 'config result.applyFailure')
	const failureCode = literal(
		failure.code,
		['listener_not_registered', 'listener_failed', 'generation_changed'],
		'config result.applyFailure.code',
	)
	return Object.freeze({
		ok: true,
		saved: true,
		application: 'saved-not-applied',
		desiredRevision,
		appliedRevision,
		config,
		report,
		applyFailure: Object.freeze({
			code: failureCode,
			message: text(failure.message, 'config result.applyFailure.message'),
		}),
	})
}

function configFailure(value: Record<string, unknown>): ConfigResult {
	const code = literal(
		value.code,
		[
			'validation_failed',
			'invalid_input',
			'node_unavailable',
			'config_not_found',
			'mutation_rejected',
			'persistence_failed',
		],
		'config result.code',
	)
	if (code === 'validation_failed') {
		shape(value, ['ok', 'code', 'state', 'message', 'errors'], ['defaults'], 'config result')
		literal(value.state, ['unchanged'], 'config result.state')
		return Object.freeze({
			ok: false,
			code,
			state: 'unchanged',
			message: text(value.message, 'config result.message'),
			errors: configValidationErrors(value.errors, 'config result.errors'),
			...(value.defaults === undefined
				? {}
				: { defaults: portableRecord(value.defaults, 'config result.defaults') }),
		})
	}
	if (code === 'persistence_failed') {
		shape(value, ['ok', 'code', 'state', 'message', 'config'], [], 'config result')
		literal(value.state, ['unknown'], 'config result.state')
		return Object.freeze({
			ok: false,
			code,
			state: 'unknown',
			message: text(value.message, 'config result.message'),
			config: portableRecord(value.config, 'config result.config'),
		})
	}
	shape(value, ['ok', 'code', 'state', 'message'], [], 'config result')
	literal(value.state, ['unchanged'], 'config result.state')
	return Object.freeze({
		ok: false,
		code,
		state: 'unchanged',
		message: text(value.message, 'config result.message'),
	})
}

function configValidationErrors(input: unknown, label: string): ConfigValidationErrors {
	const fields = object(input, label)
	const output: Record<
		string,
		Readonly<Record<string, readonly Readonly<{ message: string; path: readonly string[] }>[]>>
	> = Object.create(null)
	for (const [fieldName, sectionsInput] of Object.entries(fields)) {
		const sectionLabel = `${label}.${fieldName}`
		const sections = object(sectionsInput, sectionLabel)
		const sectionOutput: Record<string, { message: string; path: string[] }[]> = Object.create(null)
		for (const [sectionName, errorsInput] of Object.entries(sections)) {
			const errorsLabel = `${sectionLabel}.${sectionName}`
			sectionOutput[sectionName] = Object.freeze(
				array(errorsInput, errorsLabel).map((errorInput, index) => {
					const errorLabel = `${errorsLabel}[${index}]`
					const error = object(errorInput, errorLabel)
					shape(error, ['message', 'path'], [], errorLabel)
					return Object.freeze({
						message: text(error.message, `${errorLabel}.message`),
						path: Object.freeze(
							array(error.path, `${errorLabel}.path`).map((segment, pathIndex) =>
								text(segment, `${errorLabel}.path[${pathIndex}]`),
							),
						) as string[],
					})
				}),
			) as { message: string; path: string[] }[]
		}
		output[fieldName] = Object.freeze(sectionOutput)
	}
	return Object.freeze(output)
}

function dependencyRef(input: unknown, label: string): PluginDependencyRef {
	const value = object(input, label)
	shape(value, ['address', 'displayName'], ['isRunning'], label)
	return Object.freeze({
		address: nodeAddress(value.address, `${label}.address`),
		displayName: text(value.displayName, `${label}.displayName`),
		...(value.isRunning === undefined
			? {}
			: { isRunning: boolean(value.isRunning, `${label}.isRunning`) }),
	})
}

function dependencyOption(input: unknown, label: string): PluginDependencyOption {
	const value = object(input, label)
	shape(value, ['address', 'displayName', 'isRunning', 'isEnabled'], [], label)
	return Object.freeze({
		address: nodeAddress(value.address, `${label}.address`),
		displayName: text(value.displayName, `${label}.displayName`),
		isRunning: boolean(value.isRunning, `${label}.isRunning`),
		isEnabled: boolean(value.isEnabled, `${label}.isEnabled`),
	})
}

function dependencyState(input: unknown, label: string): PluginDependencyState {
	const value = object(input, label)
	shape(
		value,
		['requirement', 'kind', 'effective', 'isRunning', 'selected', 'providerDefault', 'options'],
		[],
		label,
	)
	return Object.freeze({
		requirement: definitionAddress(value.requirement, `${label}.requirement`),
		kind: literal(value.kind, ['plugin', 'abstract'], `${label}.kind`),
		effective: nullableNodeAddress(value.effective, `${label}.effective`),
		isRunning: boolean(value.isRunning, `${label}.isRunning`),
		selected: nullableNodeAddress(value.selected, `${label}.selected`),
		providerDefault: nullableNodeAddress(value.providerDefault, `${label}.providerDefault`),
		options: Object.freeze(
			array(value.options, `${label}.options`).map((item, index) =>
				dependencyOption(item, `${label}.options[${index}]`),
			),
		) as PluginDependencyOption[],
	})
}

function dependencyQueryFailure(
	value: Record<string, unknown>,
	label: string,
): PluginDependencyListResult & PluginDependencyInspectionResult & BaseProviderInspectionResult {
	if (value.ok !== false) fail(`${label}.ok must be boolean`)
	shape(value, ['ok', 'code', 'state', 'error'], [], label)
	return Object.freeze({
		ok: false,
		code: literal(value.code, ['invalid_input', 'consumer_unavailable'], `${label}.code`),
		state: literal(value.state, ['unchanged'], `${label}.state`),
		error: text(value.error, `${label}.error`),
	}) as PluginDependencyListResult & PluginDependencyInspectionResult & BaseProviderInspectionResult
}

function baseProviderInfo(input: unknown, label: string): BaseProviderInfo {
	const value = object(input, label)
	shape(value, ['token', 'currentDefault', 'isDefault', 'providers'], [], label)
	return Object.freeze({
		token: definitionAddress(value.token, `${label}.token`),
		currentDefault: nullableNodeAddress(value.currentDefault, `${label}.currentDefault`),
		isDefault: boolean(value.isDefault, `${label}.isDefault`),
		providers: Object.freeze(
			array(value.providers, `${label}.providers`).map((item, index) =>
				dependencyOption(item, `${label}.providers[${index}]`),
			),
		) as PluginDependencyOption[],
	})
}

function pluginApplyReport(input: unknown, label: string): PluginApplyReport {
	const value = object(input, label)
	shape(value, ['catalogRevision', 'runtimeStateRevision', 'reconciliation', 'core'], [], label)
	const core = object(value.core, `${label}.core`)
	const status = literal(core.status, ['unchanged', 'committed'], `${label}.core.status`)
	const parsedCore: PluginApplyReport['core'] =
		status === 'unchanged'
			? (() => {
					shape(core, ['status'], [], `${label}.core`)
					return Object.freeze({ status: 'unchanged' as const })
				})()
			: (() => {
					shape(core, ['status', 'summary'], [], `${label}.core`)
					return Object.freeze({
						status: 'committed' as const,
						summary: pluginApplyCommitSummary(core.summary, `${label}.core.summary`),
					})
				})()
	return Object.freeze({
		catalogRevision: nonNegativeInteger(value.catalogRevision, `${label}.catalogRevision`),
		runtimeStateRevision: nonNegativeInteger(
			value.runtimeStateRevision,
			`${label}.runtimeStateRevision`,
		),
		reconciliation: Object.freeze(
			array(value.reconciliation, `${label}.reconciliation`).map((item, index) =>
				reconciliationIssue(item, `${label}.reconciliation[${index}]`),
			),
		),
		core: parsedCore,
	})
}

function reconciliationIssue(input: unknown, label: string): PluginReconciliationIssue {
	const value = object(input, label)
	const kind = literal(
		value.kind,
		[
			'consumer_unavailable',
			'requirement_removed',
			'provider_unavailable',
			'provider_disabled',
			'provider_incompatible',
			'fork_not_allowed',
			'fork_default_forbidden',
			'provider_default_requires_abstract',
			'explicit_binding_invalid',
			'missing_required_provider',
		],
		`${label}.kind`,
	)
	const message = text(value.message, `${label}.message`)
	if (kind === 'consumer_unavailable' || kind === 'missing_required_provider') {
		shape(
			value,
			kind === 'consumer_unavailable'
				? ['kind', 'consumer', 'message']
				: ['kind', 'consumer', 'requirement', 'message'],
			[],
			label,
		)
		return kind === 'consumer_unavailable'
			? Object.freeze({
					kind,
					consumer: nodeAddress(value.consumer, `${label}.consumer`),
					message,
				})
			: Object.freeze({
					kind,
					consumer: nodeAddress(value.consumer, `${label}.consumer`),
					requirement: definitionAddress(value.requirement, `${label}.requirement`),
					message,
				})
	}
	if (kind === 'requirement_removed') {
		shape(value, ['kind', 'binding', 'consumer', 'requirement', 'provider', 'message'], [], label)
		literal(value.binding, ['dependency-override'], `${label}.binding`)
		return Object.freeze({
			kind,
			binding: 'dependency-override',
			consumer: nodeAddress(value.consumer, `${label}.consumer`),
			requirement: definitionAddress(value.requirement, `${label}.requirement`),
			provider: nodeAddress(value.provider, `${label}.provider`),
			message,
		})
	}
	if (
		kind === 'provider_unavailable' ||
		kind === 'provider_disabled' ||
		kind === 'provider_incompatible'
	) {
		shape(value, ['kind', 'binding', 'requirement', 'provider', 'message'], ['consumer'], label)
		return Object.freeze({
			kind,
			binding: literal(
				value.binding,
				['provider-default', 'dependency-override'],
				`${label}.binding`,
			),
			...(value.consumer === undefined
				? {}
				: { consumer: nodeAddress(value.consumer, `${label}.consumer`) }),
			requirement: definitionAddress(value.requirement, `${label}.requirement`),
			provider: nodeAddress(value.provider, `${label}.provider`),
			message,
		})
	}
	if (kind === 'fork_not_allowed') {
		shape(value, ['kind', 'node', 'message'], [], label)
		return Object.freeze({
			kind,
			node: nodeAddress(value.node, `${label}.node`),
			message,
		})
	}
	if (kind === 'fork_default_forbidden' || kind === 'provider_default_requires_abstract') {
		shape(value, ['kind', 'requirement', 'provider', 'message'], [], label)
		return Object.freeze({
			kind,
			requirement: definitionAddress(value.requirement, `${label}.requirement`),
			provider: nodeAddress(value.provider, `${label}.provider`),
			message,
		})
	}
	shape(value, ['kind', 'binding', 'requirement', 'provider', 'message'], ['consumer'], label)
	return Object.freeze({
		kind: 'explicit_binding_invalid',
		binding: literal(
			value.binding,
			['provider-default', 'dependency-override'],
			`${label}.binding`,
		),
		...(value.consumer === undefined
			? {}
			: { consumer: nodeAddress(value.consumer, `${label}.consumer`) }),
		requirement: definitionAddress(value.requirement, `${label}.requirement`),
		provider: nodeAddress(value.provider, `${label}.provider`),
		message,
	})
}

function pluginApplyCommitSummary(input: unknown, label: string): PluginApplyCommitSummary {
	const value = object(input, label)
	shape(value, ['pluginChanges', 'runtimeUpdate', 'lifecycleReport'], [], label)
	const changes = object(value.pluginChanges, `${label}.pluginChanges`)
	shape(
		changes,
		['added', 'replaced', 'removed', 'restarted', 'availabilityChanged'],
		[],
		`${label}.pluginChanges`,
	)
	const runtimeUpdate = object(value.runtimeUpdate, `${label}.runtimeUpdate`)
	shape(runtimeUpdate, [], ['reason'], `${label}.runtimeUpdate`)
	const lifecycleReport = object(value.lifecycleReport, `${label}.lifecycleReport`)
	shape(lifecycleReport, ['ok', 'issues'], [], `${label}.lifecycleReport`)
	const issues = array(lifecycleReport.issues, `${label}.lifecycleReport.issues`).map(
		(item, index) => lifecycleIssue(item, `${label}.lifecycleReport.issues[${index}]`),
	)
	const ok = boolean(lifecycleReport.ok, `${label}.lifecycleReport.ok`)
	if (ok !== (issues.length === 0)) {
		fail(`${label}.lifecycleReport.ok is inconsistent with issues`)
	}
	const parsedRuntimeUpdate =
		runtimeUpdate.reason === undefined
			? Object.freeze({})
			: Object.freeze({ reason: text(runtimeUpdate.reason, `${label}.runtimeUpdate.reason`) })
	return Object.freeze({
		pluginChanges: Object.freeze({
			added: addressArray(changes.added, `${label}.pluginChanges.added`),
			replaced: Object.freeze(
				array(changes.replaced, `${label}.pluginChanges.replaced`).map((item, index) => {
					const replacementLabel = `${label}.pluginChanges.replaced[${index}]`
					const replacement = object(item, replacementLabel)
					shape(replacement, ['from', 'to'], [], replacementLabel)
					return Object.freeze({
						from: nodeAddress(replacement.from, `${replacementLabel}.from`),
						to: nodeAddress(replacement.to, `${replacementLabel}.to`),
					})
				}),
			),
			removed: addressArray(changes.removed, `${label}.pluginChanges.removed`),
			restarted: addressArray(changes.restarted, `${label}.pluginChanges.restarted`),
			availabilityChanged: addressArray(
				changes.availabilityChanged,
				`${label}.pluginChanges.availabilityChanged`,
			),
		}),
		runtimeUpdate: parsedRuntimeUpdate,
		lifecycleReport: Object.freeze({ ok, issues: Object.freeze(issues) }),
	})
}

function lifecycleIssue(input: unknown, label: string): PluginApplyLifecycleIssue {
	const value = object(input, label)
	shape(value, ['plugin', 'phase', 'kind', 'message'], ['error', 'blockedBy'], label)
	return Object.freeze({
		plugin: nodeAddress(value.plugin, `${label}.plugin`),
		phase: literal(value.phase, LIFECYCLE_PHASES, `${label}.phase`),
		kind: literal(value.kind, LIFECYCLE_KINDS, `${label}.kind`),
		message: text(value.message, `${label}.message`),
		...(value.error === undefined ? {} : { error: lifecycleError(value.error, `${label}.error`) }),
		...(value.blockedBy === undefined
			? {}
			: { blockedBy: nodeAddress(value.blockedBy, `${label}.blockedBy`) }),
	})
}

function lifecycleError(input: unknown, label: string): PluginApplyLifecycleErrorInfo {
	const value = object(input, label)
	shape(value, ['name', 'message'], ['stack', 'cause', 'partPath'], label)
	return Object.freeze({
		name: text(value.name, `${label}.name`),
		message: text(value.message, `${label}.message`),
		...(value.stack === undefined ? {} : { stack: text(value.stack, `${label}.stack`) }),
		...(value.cause === undefined ? {} : { cause: text(value.cause, `${label}.cause`) }),
		...(value.partPath === undefined
			? {}
			: {
					partPath: Object.freeze(
						array(value.partPath, `${label}.partPath`).map((item, index) =>
							text(item, `${label}.partPath[${index}]`),
						),
					),
				}),
	})
}

function removeForkSuccess(value: Record<string, unknown>): RemoveForkResult {
	const status = literal(
		value.status,
		['removed', 'removed-with-lifecycle-issues', 'already-absent'],
		'remove fork result.status',
	)
	shape(
		value,
		status === 'already-absent' ? ['ok', 'status', 'fork'] : ['ok', 'status', 'fork', 'report'],
		[],
		'remove fork result',
	)
	const fork = nodeAddress(value.fork, 'remove fork result.fork')
	return status === 'already-absent'
		? Object.freeze({ ok: true, status, fork })
		: Object.freeze({
				ok: true,
				status,
				fork,
				report: pluginApplyReport(value.report, 'remove fork result.report'),
			})
}

function removeForkFailure(value: Record<string, unknown>): RemoveForkResult {
	const code = literal(
		value.code,
		['invalid_input', 'invalid_fork_id', 'graph_rejected', 'fork_referenced', 'persistence_failed'],
		'remove fork result.code',
	)
	if (code === 'fork_referenced') {
		shape(value, ['ok', 'code', 'state', 'references', 'error'], [], 'remove fork result')
		literal(value.state, ['unchanged'], 'remove fork result.state')
		return Object.freeze({
			ok: false,
			code,
			state: 'unchanged',
			references: Object.freeze(
				array(value.references, 'remove fork result.references').map((item, index) => {
					const label = `remove fork result.references[${index}]`
					const reference = object(item, label)
					shape(reference, ['consumer', 'requirement'], [], label)
					return Object.freeze({
						consumer: nodeAddress(reference.consumer, `${label}.consumer`),
						requirement: definitionAddress(reference.requirement, `${label}.requirement`),
					})
				}),
			),
			error: text(value.error, 'remove fork result.error'),
		})
	}
	if (code === 'persistence_failed') {
		shape(value, ['ok', 'code', 'state', 'fork', 'error'], ['report'], 'remove fork result')
		return Object.freeze({
			ok: false,
			code,
			state: literal(
				value.state,
				['retained', 'disabled-retained', 'unknown'],
				'remove fork result.state',
			),
			fork: nodeAddress(value.fork, 'remove fork result.fork'),
			...(value.report === undefined
				? {}
				: { report: pluginApplyReport(value.report, 'remove fork result.report') }),
			error: text(value.error, 'remove fork result.error'),
		})
	}
	shape(value, ['ok', 'code', 'state', 'error'], [], 'remove fork result')
	literal(value.state, ['unchanged'], 'remove fork result.state')
	return Object.freeze({
		ok: false,
		code,
		state: 'unchanged',
		error: text(value.error, 'remove fork result.error'),
	})
}

function statusMutationResult(input: unknown, label: string): PluginStatusMutationResult {
	const value = object(input, label)
	return value.ok === true
		? statusMutationSuccess(value, label)
		: statusMutationFailure(value, label)
}

function statusMutationSuccess(input: unknown, label: string): PluginStatusMutationSuccess {
	const value = object(input, label)
	if (value.ok !== true) fail(`${label}.ok must be true`)
	shape(
		value,
		['address', 'ok', 'status', 'report', 'isRunning', 'isEnabled', 'lifecycleStage'],
		[],
		label,
	)
	literal(value.status, ['applied'], `${label}.status`)
	const lifecycleStage = literal(
		value.lifecycleStage,
		['running', 'stopped', 'disabled'],
		`${label}.lifecycleStage`,
	)
	const isRunning = boolean(value.isRunning, `${label}.isRunning`)
	const isEnabled = boolean(value.isEnabled, `${label}.isEnabled`)
	if (
		isRunning !== (lifecycleStage === 'running') ||
		isEnabled !== (lifecycleStage !== 'disabled')
	) {
		fail(`${label} lifecycle booleans are inconsistent with lifecycleStage`)
	}
	return Object.freeze({
		address: nodeAddress(value.address, `${label}.address`),
		ok: true,
		status: 'applied',
		report: pluginApplyReport(value.report, `${label}.report`),
		isRunning,
		isEnabled,
		lifecycleStage,
	})
}

function statusMutationFailure(input: unknown, label: string): PluginStatusMutationFailure {
	const value = object(input, label)
	if (value.ok !== false) fail(`${label}.ok must be false`)
	shape(value, ['address', 'ok', 'code', 'state', 'error'], [], label)
	const code = literal(
		value.code,
		[
			'plugin_not_found',
			'restart_unavailable',
			'graph_rejected',
			'state_mutation_rejected',
			'persistence_failed',
		],
		`${label}.code`,
	)
	const state = literal(
		value.state,
		code === 'persistence_failed' ? ['unknown'] : ['unchanged'],
		`${label}.state`,
	)
	return Object.freeze({
		address: nodeAddress(value.address, `${label}.address`),
		ok: false,
		code,
		state,
		error: text(value.error, `${label}.error`),
	}) as PluginStatusMutationFailure
}

function commandInventoryItem(input: unknown, label: string): CommandInventoryItem {
	const value = object(input, label)
	shape(value, ['name', 'description', 'behavior'], ['title'], label)
	return Object.freeze({
		name: text(value.name, `${label}.name`),
		...(value.title === undefined ? {} : { title: text(value.title, `${label}.title`) }),
		description: text(value.description, `${label}.description`),
		behavior: commandBehavior(value.behavior, `${label}.behavior`),
	})
}

function commandBehavior(input: unknown, label: string): CommandInventoryItem['behavior'] {
	const value = object(input, label)
	const kind = literal(value.kind, ['query', 'mutation'], `${label}.kind`)
	if (kind === 'query') {
		shape(value, ['kind', 'world'], [], label)
		return Object.freeze({
			kind,
			world: literal(value.world, ['closed', 'open'], `${label}.world`),
		})
	}
	shape(value, ['kind', 'destructive', 'idempotent', 'world'], [], label)
	return Object.freeze({
		kind,
		destructive: boolean(value.destructive, `${label}.destructive`),
		idempotent: boolean(value.idempotent, `${label}.idempotent`),
		world: literal(value.world, ['closed', 'open'], `${label}.world`),
	})
}

function agentToolsPolicy(input: unknown, label: string): AgentToolsPolicy {
	const value = object(input, label)
	shape(value, ['toolsets', 'agents'], [], label)
	return Object.freeze({
		toolsets: Object.freeze(
			array(value.toolsets, `${label}.toolsets`).map((item, index) =>
				commandToolset(item, `${label}.toolsets[${index}]`),
			),
		),
		agents: Object.freeze(
			array(value.agents, `${label}.agents`).map((item, index) =>
				agentAssignment(item, `${label}.agents[${index}]`),
			),
		),
	})
}

function commandToolset(input: unknown, label: string): CommandToolset {
	const value = object(input, label)
	shape(value, ['id', 'label', 'commandNames'], ['description'], label)
	return Object.freeze({
		id: text(value.id, `${label}.id`),
		label: text(value.label, `${label}.label`),
		...(value.description === undefined
			? {}
			: { description: text(value.description, `${label}.description`) }),
		commandNames: Object.freeze(
			array(value.commandNames, `${label}.commandNames`).map((item, index) =>
				text(item, `${label}.commandNames[${index}]`),
			),
		),
	})
}

function agentAssignment(input: unknown, label: string): AgentToolAssignment {
	const value = object(input, label)
	shape(value, ['agentId', 'label', 'toolsetIds'], [], label)
	return Object.freeze({
		agentId: text(value.agentId, `${label}.agentId`),
		label: text(value.label, `${label}.label`),
		toolsetIds: Object.freeze(
			array(value.toolsetIds, `${label}.toolsetIds`).map((item, index) =>
				text(item, `${label}.toolsetIds[${index}]`),
			),
		),
	})
}

/** Validate and deep-freeze the HTTP log-stream index. */
export function parseRuntimeLogStreamsIndex(
	input: unknown,
): Readonly<{ streams: readonly LogStreamMeta[] }> {
	const value = rootRecord(input, 'log streams index')
	shape(value, ['streams'], [], 'log streams index')
	return Object.freeze({
		streams: Object.freeze(
			array(value.streams, 'log streams index.streams').map((item, index) =>
				logStreamMeta(item, `log streams index.streams[${index}]`),
			),
		),
	})
}

/** Validate and deep-freeze HTTP log-stream metadata. */
export function parseLogStreamMeta(input: unknown): LogStreamMeta {
	return logStreamMeta(rootValue(input, 'log stream metadata'), 'log stream metadata')
}

/** Validate and deep-freeze an HTTP log range result. */
export function parseLogRangeResult(input: unknown): LogRangeResult {
	const value = rootRecord(input, 'log range result')
	if (value.ok === true) {
		shape(value, ['ok', 'streamId', 'epoch', 'fromSeq', 'nextSeq', 'lines'], [], 'log range result')
		return Object.freeze({
			ok: true,
			streamId: text(value.streamId, 'log range result.streamId'),
			epoch: nonNegativeInteger(value.epoch, 'log range result.epoch'),
			fromSeq: uint64Text(value.fromSeq, 'log range result.fromSeq'),
			nextSeq: uint64Text(value.nextSeq, 'log range result.nextSeq'),
			lines: Object.freeze(
				array(value.lines, 'log range result.lines').map((item, index) =>
					logLine(item, `log range result.lines[${index}]`),
				),
			) as RuntimeLogLine[],
		})
	}
	if (value.ok !== false) fail('log range result.ok must be boolean')
	shape(
		value,
		['ok', 'code'],
		['message', 'streamId', 'epoch', 'headSeq', 'tailSeq'],
		'log range result',
	)
	return Object.freeze({
		ok: false,
		code: literal(
			value.code,
			['epoch_mismatch', 'from_too_old', 'invalid'],
			'log range result.code',
		),
		...(value.message === undefined
			? {}
			: { message: text(value.message, 'log range result.message') }),
		...(value.streamId === undefined
			? {}
			: { streamId: text(value.streamId, 'log range result.streamId') }),
		...(value.epoch === undefined
			? {}
			: { epoch: nonNegativeInteger(value.epoch, 'log range result.epoch') }),
		...(value.headSeq === undefined
			? {}
			: { headSeq: uint64Text(value.headSeq, 'log range result.headSeq') }),
		...(value.tailSeq === undefined
			? {}
			: { tailSeq: uint64Text(value.tailSeq, 'log range result.tailSeq') }),
	})
}

/** Validate and deep-freeze the security overview HTTP payload. */
export function parseSecurityOverview(input: unknown): SecurityOverview {
	const value = rootRecord(input, 'security overview')
	shape(value, ['adminAccess', 'vault'], [], 'security overview')
	const vault = object(value.vault, 'security overview.vault')
	if (vault.enabled === false) {
		shape(vault, ['enabled'], [], 'security overview.vault')
		return Object.freeze({
			adminAccess: adminAccessOverview(value.adminAccess, 'security overview.adminAccess'),
			vault: Object.freeze({ enabled: false as const }),
		})
	}
	if (vault.enabled !== true) fail('security overview.vault.enabled must be boolean')
	shape(vault, ['enabled', 'state'], [], 'security overview.vault')
	return Object.freeze({
		adminAccess: adminAccessOverview(value.adminAccess, 'security overview.adminAccess'),
		vault: Object.freeze({
			enabled: true as const,
			state: vaultAdminState(vault.state, 'security overview.vault.state'),
		}),
	})
}

/** Validate and deep-freeze the security audit list HTTP payload. */
export function parseSecurityAuditEvents(input: unknown): readonly SecurityAuditEvent[] {
	const value = rootArray(input, 'security audit events')
	return Object.freeze(
		value.map((item, index) => securityAuditEvent(item, `security audit events[${index}]`)),
	)
}

/** Validate and deep-freeze a Vault administration state HTTP payload. */
export function parseVaultAdminState(input: unknown): VaultAdminState {
	return vaultAdminState(rootValue(input, 'vault admin state'), 'vault admin state')
}

/** Validate and deep-freeze the public host-key HTTP payload. */
export function parseVaultPublicKeyResult(input: unknown): Readonly<{ publicKey: string }> {
	const value = rootRecord(input, 'vault public key result')
	shape(value, ['publicKey'], [], 'vault public key result')
	return Object.freeze({ publicKey: text(value.publicKey, 'vault public key result.publicKey') })
}

/** Validate and deep-freeze a generated Vault deploy key pair. */
export function parseVaultKeyPair(
	input: unknown,
): Awaited<ReturnType<RuntimeSecurityClient['vault']['generateDeployKey']>> {
	const value = rootRecord(input, 'vault key pair')
	shape(value, ['publicKey', 'privateKey', 'envName'], [], 'vault key pair')
	return Object.freeze({
		publicKey: text(value.publicKey, 'vault key pair.publicKey'),
		privateKey: text(value.privateKey, 'vault key pair.privateKey'),
		envName: text(value.envName, 'vault key pair.envName'),
	})
}

function logStreamMeta(input: unknown, label: string): LogStreamMeta {
	const value = object(input, label)
	shape(
		value,
		['streamId', 'bootId', 'epoch', 'headSeq', 'tailSeq', 'nextSeq', 'count', 'retention'],
		[],
		label,
	)
	const retention = object(value.retention, `${label}.retention`)
	shape(retention, ['windowLines'], [], `${label}.retention`)
	return Object.freeze({
		streamId: text(value.streamId, `${label}.streamId`),
		bootId: text(value.bootId, `${label}.bootId`),
		epoch: nonNegativeInteger(value.epoch, `${label}.epoch`),
		headSeq: uint64Text(value.headSeq, `${label}.headSeq`),
		tailSeq: uint64Text(value.tailSeq, `${label}.tailSeq`),
		nextSeq: uint64Text(value.nextSeq, `${label}.nextSeq`),
		count: nonNegativeInteger(value.count, `${label}.count`),
		retention: Object.freeze({
			windowLines: nonNegativeInteger(retention.windowLines, `${label}.retention.windowLines`),
		}),
	})
}

function logLine(input: unknown, label: string): RuntimeLogLine {
	const value = object(input, label)
	shape(
		value,
		['streamId', 'epoch', 'seq', 'ts', 'level', 'category', 'msg'],
		['name', 'plugin', 'context', 'message', 'props', 'error', 'raw'],
		label,
	)
	return Object.freeze({
		streamId: text(value.streamId, `${label}.streamId`),
		epoch: nonNegativeInteger(value.epoch, `${label}.epoch`),
		seq: uint64Text(value.seq, `${label}.seq`),
		ts: finiteNumber(value.ts, `${label}.ts`),
		level: literal(value.level, LOG_LEVELS, `${label}.level`),
		category: Object.freeze(
			array(value.category, `${label}.category`).map((item, index) =>
				text(item, `${label}.category[${index}]`),
			),
		) as string[],
		...(value.name === undefined ? {} : { name: text(value.name, `${label}.name`) }),
		...(value.plugin === undefined ? {} : { plugin: nodeAddress(value.plugin, `${label}.plugin`) }),
		...(value.context === undefined ? {} : { context: text(value.context, `${label}.context`) }),
		msg: text(value.msg, `${label}.msg`),
		...(value.message === undefined
			? {}
			: { message: Object.freeze([...array(value.message, `${label}.message`)]) as unknown[] }),
		...(value.props === undefined ? {} : { props: portableRecord(value.props, `${label}.props`) }),
		...(value.error === undefined ? {} : { error: runtimeLogError(value.error, `${label}.error`) }),
		...(value.raw === undefined ? {} : { raw: value.raw }),
	})
}

function runtimeLogError(input: unknown, label: string): RuntimeLogError {
	const value = object(input, label)
	for (const key of ['name', 'message', 'stack'] as const) {
		if (value[key] !== undefined) text(value[key], `${label}.${key}`)
	}
	return value as RuntimeLogError
}

function adminAccessOverview(input: unknown, label: string): AdminAccessOverview {
	const value = object(input, label)
	shape(value, ['policy', 'provider'], [], label)
	const provider =
		value.provider === null
			? null
			: (() => {
					const item = object(value.provider, `${label}.provider`)
					shape(item, ['id', 'label', 'method', 'ready'], [], `${label}.provider`)
					return Object.freeze({
						id: text(item.id, `${label}.provider.id`),
						label: text(item.label, `${label}.provider.label`),
						method: literal(
							item.method,
							['oidc', 'password', 'password-totp'],
							`${label}.provider.method`,
						),
						ready: boolean(item.ready, `${label}.provider.ready`),
					})
				})()
	return Object.freeze({
		policy: literal(value.policy, ['provider-or-local-recovery'], `${label}.policy`),
		provider,
	})
}

function vaultAdminState(input: unknown, label: string): VaultAdminState {
	const value = object(input, label)
	shape(
		value,
		['present', 'unlocked', 'unlockedBy', 'deploy', 'hostIdentityPresent'],
		['reason', 'lastError', 'namespaces'],
		label,
	)
	const deploy = object(value.deploy, `${label}.deploy`)
	shape(deploy, ['env', 'identityPresent', 'recipients'], [], `${label}.deploy`)
	return Object.freeze({
		present: boolean(value.present, `${label}.present`),
		unlocked: boolean(value.unlocked, `${label}.unlocked`),
		...(value.reason === undefined
			? {}
			: { reason: literal(value.reason, ['unlock_required'], `${label}.reason`) }),
		unlockedBy:
			value.unlockedBy === null
				? null
				: literal(value.unlockedBy, ['host', 'deploy'], `${label}.unlockedBy`),
		...(value.lastError === undefined
			? {}
			: { lastError: vaultStatusError(value.lastError, `${label}.lastError`) }),
		deploy: Object.freeze({
			env: text(deploy.env, `${label}.deploy.env`),
			identityPresent: boolean(deploy.identityPresent, `${label}.deploy.identityPresent`),
			recipients: Object.freeze(
				array(deploy.recipients, `${label}.deploy.recipients`).map((item, index) =>
					text(item, `${label}.deploy.recipients[${index}]`),
				),
			) as string[],
		}),
		hostIdentityPresent: boolean(value.hostIdentityPresent, `${label}.hostIdentityPresent`),
		...(value.namespaces === undefined
			? {}
			: {
					namespaces: Object.freeze(
						array(value.namespaces, `${label}.namespaces`).map((item, index) =>
							vaultNamespace(item, `${label}.namespaces[${index}]`),
						),
					) as VaultAdminState['namespaces'],
				}),
	})
}

function vaultStatusError(
	input: unknown,
	label: string,
): NonNullable<VaultAdminState['lastError']> {
	const value = object(input, label)
	shape(value, ['code', 'message'], [], label)
	return Object.freeze({
		code: text(value.code, `${label}.code`),
		message: text(value.message, `${label}.message`),
	})
}

function vaultNamespace(
	input: unknown,
	label: string,
): NonNullable<VaultAdminState['namespaces']>[number] {
	const value = object(input, label)
	shape(value, ['namespace', 'kvKeys', 'docDocuments', 'blobs'], [], label)
	return Object.freeze({
		namespace: text(value.namespace, `${label}.namespace`),
		kvKeys: nonNegativeInteger(value.kvKeys, `${label}.kvKeys`),
		docDocuments: nonNegativeInteger(value.docDocuments, `${label}.docDocuments`),
		blobs: nonNegativeInteger(value.blobs, `${label}.blobs`),
	})
}

function securityAuditEvent(input: unknown, label: string): SecurityAuditEvent {
	const value = object(input, label)
	shape(value, ['id', 'at', 'area', 'action', 'status', 'message'], ['mount', 'reason'], label)
	return Object.freeze({
		id: text(value.id, `${label}.id`),
		at: finiteNumber(value.at, `${label}.at`),
		area: literal(value.area, ['adminAccess', 'vault'], `${label}.area`),
		action: literal(
			value.action,
			['authorize', 'verify', 'clear', 'preflight', 'unlock', 'rekey'],
			`${label}.action`,
		),
		status: literal(value.status, ['success', 'failure', 'info'], `${label}.status`),
		...(value.mount === undefined ? {} : { mount: text(value.mount, `${label}.mount`) }),
		...(value.reason === undefined ? {} : { reason: text(value.reason, `${label}.reason`) }),
		message: text(value.message, `${label}.message`),
	})
}

function rootValue(input: unknown, label: string): RuntimeJsonValue {
	const value = parseRuntimePortableData(input, label)
	rejectDangerousFields(value, label)
	return value
}

function rootRecord(input: unknown, label: string): Record<string, unknown> {
	return object(rootValue(input, label), label)
}

function rootArray(input: unknown, label: string): readonly RuntimeJsonValue[] {
	return array(rootValue(input, label), label)
}

function rejectDangerousFields(input: RuntimeJsonValue, label: string): void {
	if (input === null || typeof input !== 'object') return
	if (Array.isArray(input)) {
		for (let index = 0; index < input.length; index += 1) {
			rejectDangerousFields(input[index]!, `${label}[${index}]`)
		}
		return
	}
	for (const [key, value] of Object.entries(input)) {
		if (DANGEROUS_FIELDS.has(key)) fail(`${label} contains reserved field ${key}`)
		rejectDangerousFields(value, `${label}.${key}`)
	}
}

function object(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		fail(`${label} must be an object`)
	}
	return input as Record<string, unknown>
}

function array(input: unknown, label: string): readonly RuntimeJsonValue[] {
	if (!Array.isArray(input)) fail(`${label} must be an array`)
	return input as readonly RuntimeJsonValue[]
}

function portableRecord(input: unknown, label: string): RuntimeJsonObject {
	return object(input, label) as RuntimeJsonObject
}

function shape(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
	label: string,
): void {
	const allowed = new Set([...required, ...optional])
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) fail(`${label} contains unsupported field ${key}`)
	}
	for (const key of required) {
		if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`)
	}
}

function text(input: unknown, label: string): string {
	if (typeof input !== 'string') fail(`${label} must be a string`)
	return input
}

function nullableText(input: unknown, label: string): string | null {
	return input === null ? null : text(input, label)
}

function boolean(input: unknown, label: string): boolean {
	if (typeof input !== 'boolean') fail(`${label} must be boolean`)
	return input
}

function finiteNumber(input: unknown, label: string): number {
	if (typeof input !== 'number' || !Number.isFinite(input)) {
		fail(`${label} must be a finite number`)
	}
	return input
}

function nonNegativeInteger(input: unknown, label: string): number {
	if (!Number.isSafeInteger(input) || (input as number) < 0) {
		fail(`${label} must be a non-negative safe integer`)
	}
	return input as number
}

function nullableNonNegativeInteger(input: unknown, label: string): number | null {
	return input === null ? null : nonNegativeInteger(input, label)
}

function uint64Text(input: unknown, label: string): string {
	const value = text(input, label)
	if (!/^(?:0|[1-9]\d{0,19})$/.test(value)) fail(`${label} must be a uint64 string`)
	if (BigInt(value) > 18_446_744_073_709_551_615n) fail(`${label} exceeds uint64`)
	return value
}

function literal<const T extends string>(input: unknown, allowed: readonly T[], label: string): T {
	if (typeof input !== 'string' || !allowed.includes(input as T)) {
		fail(`${label} must be one of ${allowed.join(', ')}`)
	}
	return input as T
}

function nodeAddress(input: unknown, label: string): PluginNodeAddress {
	try {
		return parsePluginNodeAddress(input)
	} catch (error) {
		fail(`${label} is invalid: ${errorMessage(error)}`)
	}
}

function nullableNodeAddress(input: unknown, label: string): PluginNodeAddress | null {
	return input === null ? null : nodeAddress(input, label)
}

function definitionAddress(input: unknown, label: string): PluginDefinitionAddress {
	try {
		return parsePluginDefinitionAddress(input)
	} catch (error) {
		fail(`${label} is invalid: ${errorMessage(error)}`)
	}
}

function addressArray(input: unknown, label: string): readonly PluginNodeAddress[] {
	return Object.freeze(
		array(input, label).map((item, index) => nodeAddress(item, `${label}[${index}]`)),
	)
}

function runtimeLogLevel(input: unknown, label: string): RuntimePluginLogLevel {
	return literal(input, RUNTIME_LOG_LEVELS, label)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'unknown validation failure'
}

function fail(message: string): never {
	throw new RuntimeProtocolValidationError(message)
}

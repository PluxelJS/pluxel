import {
	comparePluginDefinitionAddress,
	comparePluginNodeAddress,
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
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
	ConfigPresentationResult,
	ConfigResult,
	ConfigValidationErrors,
	EnsureForkResult,
	PluginApplyCommitSummary,
	PluginApplyLifecycleErrorInfo,
	PluginApplyLifecycleIssue,
	PluginApplyReport,
	PluginControlBatchResult,
	PluginControlMutationFailure,
	PluginControlMutationResult,
	PluginControlMutationSuccess,
	PluginControlSnapshot,
	PluginDependencyGraphEdge,
	PluginDependencyGraphNode,
	PluginDependencyGraphSnapshot,
	PluginConsumerRequirementState,
	PluginConsumerRequirementsInspectionResult,
	PluginDependencyMutationResult,
	PluginProviderOption,
	PluginProviderPolicyInfo,
	PluginProviderPolicyInspectionResult,
	PluginGroup,
	PluginGroupsMutationResult,
	PluginLogPolicyMutationResult,
	PluginReconciliationIssue,
	PluginsListOutput,
	PluginStatusIssue,
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
	shape(summary, ['total', 'running', 'stopped', 'autoStart'], [], 'plugins list.summary')
	const total = nonNegativeInteger(summary.total, 'plugins list.summary.total')
	const running = nonNegativeInteger(summary.running, 'plugins list.summary.running')
	const stopped = nonNegativeInteger(summary.stopped, 'plugins list.summary.stopped')
	const autoStart = nonNegativeInteger(summary.autoStart, 'plugins list.summary.autoStart')
	if (total !== plugins.length || running + stopped !== total || autoStart > total) {
		fail('plugins list.summary is inconsistent with the catalog snapshot')
	}
	return Object.freeze({
		plugins: Object.freeze(plugins),
		summary: Object.freeze({ total, running, stopped, autoStart }),
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

/** Validate and deep-freeze the committed Plugin dependency graph snapshot. */
export function parsePluginDependencyGraphSnapshot(input: unknown): PluginDependencyGraphSnapshot {
	const value = rootRecord(input, 'plugin dependency graph')
	shape(value, ['nodes', 'edges'], [], 'plugin dependency graph')

	const nodes = array(value.nodes, 'plugin dependency graph.nodes').map((item, index) =>
		pluginDependencyGraphNode(item, `plugin dependency graph.nodes[${index}]`),
	)
	const nodesByKey = new Map<string, PluginDependencyGraphNode>()
	let previousNode: PluginDependencyGraphNode | undefined
	for (const node of nodes) {
		const key = pluginNodeIndexKey(node.status.address)
		if (nodesByKey.has(key)) {
			fail('plugin dependency graph.nodes contains a duplicate node address')
		}
		if (
			previousNode &&
			comparePluginNodeAddress(previousNode.status.address, node.status.address) > 0
		) {
			fail('plugin dependency graph.nodes must be sorted by canonical node identity')
		}
		nodesByKey.set(key, node)
		previousNode = node
	}

	const edges = array(value.edges, 'plugin dependency graph.edges').map((item, index) =>
		pluginDependencyGraphEdge(item, `plugin dependency graph.edges[${index}]`),
	)
	const edgeKeys = new Set<string>()
	let previousEdge: PluginDependencyGraphEdge | undefined
	for (const edge of edges) {
		const key = pluginDependencyGraphEdgeKey(edge)
		if (edgeKeys.has(key)) {
			fail('plugin dependency graph.edges contains a duplicate consumer and requirement')
		}
		if (previousEdge && comparePluginDependencyGraphEdge(previousEdge, edge) > 0) {
			fail(
				'plugin dependency graph.edges must be sorted by canonical consumer and requirement identity',
			)
		}
		edgeKeys.add(key)
		previousEdge = edge
		validatePluginDependencyGraphEdgeMembership(edge, nodesByKey)
	}

	validatePluginDependencyGraphDag(nodes, edges)
	return Object.freeze({
		nodes: Object.freeze(nodes),
		edges: Object.freeze(edges),
	})
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

/** Validate and deep-freeze a consumer requirement inspection result. */
export function parsePluginConsumerRequirementsInspectionResult(
	input: unknown,
): PluginConsumerRequirementsInspectionResult {
	const value = rootRecord(input, 'consumer requirements inspection result')
	if (value.ok === true) {
		shape(value, ['ok', 'items'], [], 'consumer requirements inspection result')
		return Object.freeze({
			ok: true,
			items: Object.freeze(
				array(value.items, 'consumer requirements inspection result.items').map((item, index) =>
					consumerRequirementState(item, `consumer requirements inspection result.items[${index}]`),
				),
			) as PluginConsumerRequirementState[],
		})
	}
	return consumerRequirementsQueryFailure(value, 'consumer requirements inspection result')
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
			'provider_policy_unavailable',
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

/** Validate and deep-freeze a provider policy inspection result. */
export function parsePluginProviderPolicyInspectionResult(
	input: unknown,
): PluginProviderPolicyInspectionResult {
	const value = rootRecord(input, 'provider policy inspection result')
	if (value.ok === true) {
		shape(value, ['ok', 'value'], [], 'provider policy inspection result')
		return Object.freeze({
			ok: true,
			value:
				value.value === null
					? null
					: providerPolicyInfo(value.value, 'provider policy inspection result.value'),
		})
	}
	if (value.ok !== false) fail('provider policy inspection result.ok must be boolean')
	shape(value, ['ok', 'code', 'state', 'error'], [], 'provider policy inspection result')
	return Object.freeze({
		ok: false,
		code: literal(
			value.code,
			['invalid_input', 'provider_policy_unavailable'],
			'provider policy inspection result.code',
		),
		state: literal(value.state, ['unchanged'], 'provider policy inspection result.state'),
		error: text(value.error, 'provider policy inspection result.error'),
	})
}

/** Validate and deep-freeze a fork creation/update result. */
export function parseEnsureForkResult(input: unknown): EnsureForkResult {
	const value = rootRecord(input, 'ensure fork result')
	if (value.ok === true) {
		shape(value, ['ok', 'status', 'fork', 'report'], [], 'ensure fork result')
		return Object.freeze({
			ok: true as const,
			status: literal(value.status, ['applied', 'deferred'], 'ensure fork result.status'),
			fork: nodeAddress(value.fork, 'ensure fork result.fork'),
			report: pluginApplyReport(value.report, 'ensure fork result.report'),
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

/** Validate and deep-freeze a Plugin control batch result, including partial application. */
export function parsePluginControlBatchResult(input: unknown): PluginControlBatchResult {
	const value = rootRecord(input, 'plugin control batch result')
	if (value.ok === true) {
		shape(value, ['ok', 'status', 'results'], [], 'plugin control batch result')
		literal(value.status, ['applied'], 'plugin control batch result.status')
		const results = array(value.results, 'plugin control batch result.results').map((item, index) =>
			controlMutationSuccess(item, `plugin control batch result.results[${index}]`),
		)
		return Object.freeze({
			ok: true,
			status: 'applied',
			results: Object.freeze(results) as PluginControlMutationSuccess[],
		})
	}
	if (value.ok !== false) fail('plugin control batch result.ok must be boolean')
	const status = literal(
		value.status,
		['partially-applied', 'rejected'],
		'plugin control batch result.status',
	)
	if (Object.hasOwn(value, 'code')) {
		shape(
			value,
			['ok', 'status', 'code', 'state', 'error', 'results'],
			[],
			'plugin control batch result',
		)
		if (status !== 'rejected') {
			fail('plugin control batch result with code must have rejected status')
		}
		literal(value.code, ['invalid_input'], 'plugin control batch result.code')
		literal(value.state, ['unchanged'], 'plugin control batch result.state')
		if (array(value.results, 'plugin control batch result.results').length > 0) {
			fail('plugin control batch invalid-input result must have an empty results array')
		}
		return Object.freeze({
			ok: false,
			status: 'rejected',
			code: 'invalid_input',
			state: 'unchanged',
			error: text(value.error, 'plugin control batch result.error'),
			results: Object.freeze([]) as [],
		})
	}
	shape(value, ['ok', 'status', 'results'], [], 'plugin control batch result')
	const results = array(value.results, 'plugin control batch result.results').map((item, index) =>
		controlMutationResult(item, `plugin control batch result.results[${index}]`),
	)
	if (status === 'partially-applied') {
		if (!results.some((result) => result.ok) || !results.some((result) => !result.ok)) {
			fail('partially-applied control batch must contain successes and failures')
		}
	} else if (results.some((result) => result.ok)) {
		fail('rejected control batch must not contain successful results')
	}
	return Object.freeze({
		ok: false,
		status,
		results: Object.freeze(results) as PluginControlMutationResult[],
	}) as PluginControlBatchResult
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

function pluginDependencyGraphNode(input: unknown, label: string): PluginDependencyGraphNode {
	const value = object(input, label)
	shape(value, ['status', 'effective'], [], label)
	const status = pluginStatusSnapshot(value.status, `${label}.status`)
	const effective = boolean(value.effective, `${label}.effective`)
	if (effective && (status.desiredState !== 'running' || status.availability !== 'available')) {
		fail(`${label} effective node must be desired running and available`)
	}
	return Object.freeze({ status, effective })
}

function pluginDependencyGraphEdge(input: unknown, label: string): PluginDependencyGraphEdge {
	const value = object(input, label)
	shape(value, ['consumer', 'requirement', 'mode', 'resolution', 'effective'], [], label)
	const consumer = nodeAddress(value.consumer, `${label}.consumer`)
	const requirement = definitionAddress(value.requirement, `${label}.requirement`)
	const mode = literal(value.mode, ['required', 'optional'], `${label}.mode`)
	const effective = boolean(value.effective, `${label}.effective`)
	const resolution = object(value.resolution, `${label}.resolution`)
	const state = literal(resolution.state, ['resolved', 'unresolved'], `${label}.resolution.state`)

	if (state === 'unresolved') {
		shape(resolution, ['state'], [], `${label}.resolution`)
		if (mode !== 'required') fail(`${label} optional edge must be resolved`)
		if (effective) fail(`${label} unresolved edge must be inactive`)
		return Object.freeze({
			consumer,
			requirement,
			mode: 'required',
			resolution: Object.freeze({ state: 'unresolved' }),
			effective: false,
		})
	}

	shape(resolution, ['state', 'provider', 'via'], [], `${label}.resolution`)
	const provider = nodeAddress(resolution.provider, `${label}.resolution.provider`)
	if (mode === 'optional') {
		const via = literal(resolution.via, ['direct'], `${label}.resolution.via`)
		return Object.freeze({
			consumer,
			requirement,
			mode,
			resolution: Object.freeze({ state, provider, via }),
			effective,
		})
	}

	const via = literal(
		resolution.via,
		['direct', 'provider-default', 'dependency-override'],
		`${label}.resolution.via`,
	)
	return Object.freeze({
		consumer,
		requirement,
		mode,
		resolution: Object.freeze({ state, provider, via }),
		effective,
	})
}

function validatePluginDependencyGraphEdgeMembership(
	edge: PluginDependencyGraphEdge,
	nodesByKey: ReadonlyMap<string, PluginDependencyGraphNode>,
): void {
	const consumer = nodesByKey.get(pluginNodeIndexKey(edge.consumer))
	if (!consumer) fail('plugin dependency graph edge consumer must exist in nodes')
	if (edge.resolution.state === 'unresolved') return

	const provider = nodesByKey.get(pluginNodeIndexKey(edge.resolution.provider))
	if (edge.mode === 'required' && !provider) {
		fail('plugin dependency graph resolved required edge provider must exist in nodes')
	}
	if (!edge.effective) return
	if (!consumer.effective) {
		fail('plugin dependency graph effective edge consumer must be an effective node')
	}
	if (!provider?.effective) {
		fail('plugin dependency graph effective edge provider must be an effective node')
	}
}

function validatePluginDependencyGraphDag(
	nodes: readonly PluginDependencyGraphNode[],
	edges: readonly PluginDependencyGraphEdge[],
): void {
	const incomingCount = new Map<string, number>()
	const outgoing = new Map<string, string[]>()
	for (const node of nodes) {
		if (!node.effective) continue
		const key = pluginNodeIndexKey(node.status.address)
		incomingCount.set(key, 0)
		outgoing.set(key, [])
	}
	for (const edge of edges) {
		if (!edge.effective || edge.resolution.state !== 'resolved') continue
		const consumerKey = pluginNodeIndexKey(edge.consumer)
		const providerKey = pluginNodeIndexKey(edge.resolution.provider)
		outgoing.get(consumerKey)!.push(providerKey)
		incomingCount.set(providerKey, incomingCount.get(providerKey)! + 1)
	}

	const ready: string[] = []
	for (const [key, count] of incomingCount) {
		if (count === 0) ready.push(key)
	}
	let visited = 0
	for (let index = 0; index < ready.length; index += 1) {
		const key = ready[index]!
		visited += 1
		for (const target of outgoing.get(key)!) {
			const next = incomingCount.get(target)! - 1
			incomingCount.set(target, next)
			if (next === 0) ready.push(target)
		}
	}
	if (visited !== incomingCount.size) {
		fail('plugin dependency graph effective node and edge subset must be a DAG')
	}
}

function pluginDependencyGraphEdgeKey(edge: PluginDependencyGraphEdge): string {
	return `${pluginNodeIndexKey(edge.consumer)}:${pluginDefinitionIndexKey(edge.requirement)}`
}

function comparePluginDependencyGraphEdge(
	left: PluginDependencyGraphEdge,
	right: PluginDependencyGraphEdge,
): number {
	const consumerOrder = comparePluginNodeAddress(left.consumer, right.consumer)
	return consumerOrder || comparePluginDefinitionAddress(left.requirement, right.requirement)
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
			'autoStart',
			'sessionIntent',
			'desiredState',
			'activationReason',
			'lifecycleState',
			'availability',
			'issues',
			'source',
		],
		[],
		label,
	)
	const projectedLabel = object(value.label, `${label}.label`)
	shape(projectedLabel, ['title', 'text'], ['qualifier'], `${label}.label`)
	const control = pluginControlSnapshot(value, label)
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
		...control,
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

function pluginControlSnapshot(
	value: Readonly<Record<string, unknown>>,
	label: string,
): PluginControlSnapshot {
	const autoStart = boolean(value.autoStart, `${label}.autoStart`)
	const sessionIntent = literal(
		value.sessionIntent,
		['inherit', 'run', 'stop'],
		`${label}.sessionIntent`,
	)
	const desiredState = literal(value.desiredState, ['running', 'stopped'], `${label}.desiredState`)
	const activationReason = nullableLiteral(
		value.activationReason,
		['auto-start', 'session', 'dependency'],
		`${label}.activationReason`,
	)
	const lifecycleState = literal(
		value.lifecycleState,
		['running', 'stopped'],
		`${label}.lifecycleState`,
	)
	if ((desiredState === 'running') !== (activationReason !== null)) {
		fail(`${label}.desiredState is inconsistent with activationReason`)
	}
	if (sessionIntent === 'stop' && (desiredState !== 'stopped' || activationReason !== null)) {
		fail(`${label}.sessionIntent stop must suppress activation`)
	}
	if (sessionIntent === 'run' && (desiredState !== 'running' || activationReason !== 'session')) {
		fail(`${label}.sessionIntent run must activate for the session`)
	}
	if (activationReason === 'auto-start' && (sessionIntent !== 'inherit' || autoStart !== true)) {
		fail(`${label}.activationReason auto-start requires inherited auto-start policy`)
	}
	if (activationReason === 'dependency' && (sessionIntent !== 'inherit' || autoStart !== false)) {
		fail(`${label}.activationReason dependency requires inherited non-auto-start policy`)
	}
	if (sessionIntent === 'inherit' && autoStart && activationReason !== 'auto-start') {
		fail(`${label}.inherited auto-start policy must activate through auto-start`)
	}
	if (lifecycleState === 'running' && desiredState !== 'running') {
		fail(`${label}.lifecycleState running requires desiredState running`)
	}
	return Object.freeze({
		autoStart,
		sessionIntent,
		desiredState,
		activationReason,
		lifecycleState,
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

function providerOption(input: unknown, label: string): PluginProviderOption {
	const value = object(input, label)
	shape(value, ['address', 'displayName', 'availability'], [], label)
	return Object.freeze({
		address: nodeAddress(value.address, `${label}.address`),
		displayName: text(value.displayName, `${label}.displayName`),
		availability: literal(
			value.availability,
			['available', 'unavailable'],
			`${label}.availability`,
		),
	})
}

function consumerRequirementState(input: unknown, label: string): PluginConsumerRequirementState {
	const value = object(input, label)
	shape(
		value,
		['requirement', 'kind', 'consumerOverride', 'inheritedProvider', 'options'],
		[],
		label,
	)
	return Object.freeze({
		requirement: definitionAddress(value.requirement, `${label}.requirement`),
		kind: literal(value.kind, ['plugin', 'abstract'], `${label}.kind`),
		consumerOverride: nullableNodeAddress(value.consumerOverride, `${label}.consumerOverride`),
		inheritedProvider: nullableNodeAddress(value.inheritedProvider, `${label}.inheritedProvider`),
		options: Object.freeze(
			array(value.options, `${label}.options`).map((item, index) =>
				providerOption(item, `${label}.options[${index}]`),
			),
		) as PluginProviderOption[],
	})
}

function consumerRequirementsQueryFailure(
	value: Record<string, unknown>,
	label: string,
): PluginConsumerRequirementsInspectionResult {
	if (value.ok !== false) fail(`${label}.ok must be boolean`)
	shape(value, ['ok', 'code', 'state', 'error'], [], label)
	return Object.freeze({
		ok: false,
		code: literal(value.code, ['invalid_input', 'consumer_unavailable'], `${label}.code`),
		state: literal(value.state, ['unchanged'], `${label}.state`),
		error: text(value.error, `${label}.error`),
	})
}

function providerPolicyInfo(input: unknown, label: string): PluginProviderPolicyInfo {
	const value = object(input, label)
	shape(value, ['token', 'defaultProvider', 'policyOwnerIsDefault', 'options'], [], label)
	return Object.freeze({
		token: definitionAddress(value.token, `${label}.token`),
		defaultProvider: nullableNodeAddress(value.defaultProvider, `${label}.defaultProvider`),
		policyOwnerIsDefault: boolean(value.policyOwnerIsDefault, `${label}.policyOwnerIsDefault`),
		options: Object.freeze(
			array(value.options, `${label}.options`).map((item, index) =>
				providerOption(item, `${label}.options[${index}]`),
			),
		) as PluginProviderOption[],
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
	if (kind === 'provider_unavailable' || kind === 'provider_incompatible') {
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
				['retained', 'stopped-retained', 'unknown'],
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

function controlMutationResult(input: unknown, label: string): PluginControlMutationResult {
	const value = object(input, label)
	return value.ok === true
		? controlMutationSuccess(value, label)
		: controlMutationFailure(value, label)
}

function controlMutationSuccess(input: unknown, label: string): PluginControlMutationSuccess {
	const value = object(input, label)
	if (value.ok !== true) fail(`${label}.ok must be true`)
	shape(value, ['address', 'ok', 'status', 'report', 'control'], [], label)
	literal(value.status, ['applied'], `${label}.status`)
	const controlValue = object(value.control, `${label}.control`)
	shape(
		controlValue,
		['autoStart', 'sessionIntent', 'desiredState', 'activationReason', 'lifecycleState'],
		[],
		`${label}.control`,
	)
	return Object.freeze({
		address: nodeAddress(value.address, `${label}.address`),
		ok: true,
		status: 'applied',
		report: pluginApplyReport(value.report, `${label}.report`),
		control: pluginControlSnapshot(controlValue, `${label}.control`),
	})
}

function controlMutationFailure(input: unknown, label: string): PluginControlMutationFailure {
	const value = object(input, label)
	if (value.ok !== false) fail(`${label}.ok must be false`)
	shape(value, ['address', 'ok', 'code', 'state', 'error'], [], label)
	const code = literal(
		value.code,
		[
			'plugin_not_found',
			'start_unavailable',
			'restart_unavailable',
			'node_unavailable',
			'graph_rejected',
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
	}) as PluginControlMutationFailure
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

function nullableLiteral<const T extends string>(
	input: unknown,
	allowed: readonly T[],
	label: string,
): T | null {
	return input === null ? null : literal(input, allowed, label)
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

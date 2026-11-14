import {
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type {
	PluginApplyReportSnapshot,
	PluginApplyCommitSummary,
	PluginApplyLifecycleIssue,
	PluginApplyLifecycleErrorInfo,
} from './apply-report'
import type { PluginReconciliationIssue } from './reconcile'
import type { HostPersistenceResult } from './persistence'
import { HOST_POLICY_FIELDS, type HostPolicyField } from './policy'

const LIFECYCLE_PHASES = ['resolve', 'config', 'start', 'dependency', 'drain'] as const
const LIFECYCLE_KINDS = [
	'resolve-failed',
	'config-failed',
	'start-failed',
	'dependency-blocked',
	'drain-failed',
] as const

/** Complete application facts shared by SDK, management RPC and UI consumers. */
export type PluginApplyReportOutcome =
	| Readonly<{ status: 'applied'; report: PluginApplyReportSnapshot }>
	| Readonly<{
			status: 'lifecycle_failed'
			message: string
			report: PluginApplyReportSnapshot
	  }>
	| Readonly<{
			status: 'persistence_failed'
			state: 'unknown'
			message: string
			report: PluginApplyReportSnapshot
	  }>

/** Classifies completion without discarding committed changes or persistence uncertainty. */
export function pluginApplyReportOutcome(
	report: PluginApplyReportSnapshot,
): PluginApplyReportOutcome {
	if (report.persistence.status === 'unknown') {
		return Object.freeze({
			status: 'persistence_failed',
			state: 'unknown',
			message:
				'Plugin application persistence could not be confirmed; inspect the report before continuing',
			report,
		})
	}
	if (
		report.reconciliation.length > 0 ||
		(report.core.status === 'committed' && !report.core.summary.lifecycleReport.ok)
	) {
		return Object.freeze({
			status: 'lifecycle_failed',
			message:
				'Plugin lifecycle application completed with issues; inspect the report before continuing',
			report,
		})
	}
	return Object.freeze({ status: 'applied', report })
}

/** Validate a complete address-only Host report and return an immutable snapshot. */
export function parsePluginApplyReportSnapshot(
	input: unknown,
	label = 'Plugin apply report',
): PluginApplyReportSnapshot {
	const value = object(input, label)
	shape(
		value,
		[
			'catalogRevision',
			'runtimeStateRevision',
			'reconciliation',
			'core',
			'persistence',
			'writtenFields',
		],
		[],
		label,
	)
	const core = object(value.core, `${label}.core`)
	const status = literal(core.status, ['unchanged', 'committed'], `${label}.core.status`)
	const parsedCore: PluginApplyReportSnapshot['core'] =
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
		persistence: parseHostPersistenceResult(value.persistence, `${label}.persistence`),
		writtenFields: policyFields(value.writtenFields, HOST_POLICY_FIELDS, `${label}.writtenFields`),
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

export function parseHostPersistenceResult(
	input: unknown,
	label = 'Host persistence result',
): HostPersistenceResult {
	const value = object(input, label)
	const status = literal(value.status, ['unchanged', 'confirmed', 'unknown'], `${label}.status`)
	shape(value, status === 'confirmed' ? ['status', 'retention'] : ['status'], [], label)
	return status === 'confirmed'
		? Object.freeze({
				status,
				retention: literal(
					value.retention,
					['session', 'declared-durable', 'unknown'],
					`${label}.retention`,
				),
			})
		: Object.freeze({ status })
}

function policyFields<const T extends HostPolicyField>(
	input: unknown,
	allowed: readonly T[],
	label: string,
): readonly T[] {
	const fields = array(input, label).map((field) => literal(field, allowed, label))
	if (new Set(fields).size !== fields.length) fail(`${label} contains duplicate fields`)
	return Object.freeze(fields)
}

function object(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		fail(`${label} must be an object`)
	const prototype = Object.getPrototypeOf(input)
	if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`)
	if (Object.getOwnPropertySymbols(input).length > 0) fail(`${label} must not contain symbols`)
	const descriptors = Object.getOwnPropertyDescriptors(input)
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!('value' in descriptor) || !descriptor.enumerable)
			fail(`${label}.${key} must be an enumerable data property`)
	}
	return Object.fromEntries(
		Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
	)
}

function array(input: unknown, label: string): readonly unknown[] {
	if (!Array.isArray(input)) fail(`${label} must be an array`)
	if (
		Object.getPrototypeOf(input) !== Array.prototype ||
		Object.getOwnPropertySymbols(input).length > 0
	)
		fail(`${label} must be a plain array`)
	const descriptors = Object.getOwnPropertyDescriptors(input as object)
	const length = descriptors.length!.value as number
	if (Object.keys(descriptors).length !== length + 1)
		fail(`${label} must be a dense array without extra properties`)
	const values: unknown[] = []
	for (let index = 0; index < length; index++) {
		const descriptor = descriptors[index]
		if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
			fail(`${label}[${index}] must be a data property`)
		values.push(descriptor.value)
	}
	return values
}

function shape(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
	label: string,
): void {
	const allowed = new Set([...required, ...optional])
	for (const key of Object.keys(value))
		if (!allowed.has(key)) fail(`${label} contains unsupported field ${key}`)
	for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`)
}

function text(input: unknown, label: string): string {
	if (typeof input !== 'string') fail(`${label} must be a string`)
	return input
}

function boolean(input: unknown, label: string): boolean {
	if (typeof input !== 'boolean') fail(`${label} must be boolean`)
	return input
}

function nonNegativeInteger(input: unknown, label: string): number {
	if (!Number.isSafeInteger(input) || (input as number) < 0)
		fail(`${label} must be a non-negative safe integer`)
	return input as number
}

function literal<const T extends string>(input: unknown, allowed: readonly T[], label: string): T {
	if (typeof input !== 'string' || !allowed.includes(input as T))
		fail(`${label} must be one of ${allowed.join(', ')}`)
	return input as T
}

function nodeAddress(input: unknown, label: string): PluginNodeAddress {
	const value = object(input, label)
	definitionAddress(value.definition, `${label}.definition`)
	try {
		return parsePluginNodeAddress(value)
	} catch (error) {
		fail(`${label} is invalid: ${errorMessage(error)}`)
	}
}

function definitionAddress(input: unknown, label: string): PluginDefinitionAddress {
	const value = object(input, label)
	object(value.entry, `${label}.entry`)
	try {
		return parsePluginDefinitionAddress(value)
	} catch (error) {
		fail(`${label} is invalid: ${errorMessage(error)}`)
	}
}

function addressArray(input: unknown, label: string): readonly PluginNodeAddress[] {
	return Object.freeze(
		array(input, label).map((item, index) => nodeAddress(item, `${label}[${index}]`)),
	)
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'unknown validation failure'
}

function fail(message: string): never {
	throw new TypeError(message)
}

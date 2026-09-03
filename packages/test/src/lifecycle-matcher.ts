import {
	formatPluginNodeReference,
	parsePluginNodeAddress,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
	type PluginNodeAddress,
} from '@pluxel/core'
import type {
	LifecycleFailureCommitSummary,
	PluginTestLifecycleIssue,
	PluginTestTarget,
} from '@pluxel/core/test'
import { expect, type ExpectStatic } from 'vitest'
import type { PluginLifecycleIssueExpectation } from './vitest'

type ValidatedFailureSummary = LifecycleFailureCommitSummary

const EXPECTATION_KEYS = new Set(['phase', 'kind', 'blockedBy', 'message'])
const LIFECYCLE_PHASES = new Set(['resolve', 'config', 'start', 'dependency', 'drain'])
const LIFECYCLE_KINDS = new Set([
	'resolve-failed',
	'config-failed',
	'start-failed',
	'dependency-blocked',
	'drain-failed',
])

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function usageError(detail: string): TypeError {
	return new TypeError(
		`[pluxel/test] toHavePluginLifecycleIssue() ${detail}; pass the result of commitExpectFail()`,
	)
}

function targetAddress(target: unknown, label: string): PluginNodeAddress {
	try {
		if (typeof target === 'function') return pluginNodeAddressOf(target as never)
		if (
			!isRecord(target) ||
			typeof target.plugin !== 'function' ||
			typeof target.forkId !== 'string'
		) {
			throw new TypeError('invalid target')
		}
		const defaultAddress = pluginNodeAddressOf(target.plugin as never)
		return parsePluginNodeAddress({
			definition: defaultAddress.definition,
			variant: 'fork',
			forkId: target.forkId,
		})
	} catch {
		throw usageError(
			`${label} must be a lowered concrete Plugin constructor or definePluginFork() result`,
		)
	}
}

function validateIssue(value: unknown, index: number): PluginTestLifecycleIssue {
	if (!isRecord(value) || typeof value.message !== 'string') {
		throw usageError(`received lifecycleReport.issues[${index}] is not a lifecycle issue`)
	}
	if (typeof value.phase !== 'string' || !LIFECYCLE_PHASES.has(value.phase)) {
		throw usageError(`received lifecycleReport.issues[${index}] has an invalid lifecycle phase`)
	}
	if (typeof value.kind !== 'string' || !LIFECYCLE_KINDS.has(value.kind)) {
		throw usageError(
			`received lifecycleReport.issues[${index}] has an invalid lifecycle issue kind`,
		)
	}
	let plugin: PluginNodeAddress
	let blockedBy: PluginNodeAddress | undefined
	try {
		plugin = parsePluginNodeAddress(value.plugin)
		blockedBy = value.blockedBy === undefined ? undefined : parsePluginNodeAddress(value.blockedBy)
	} catch {
		throw usageError(`received lifecycleReport.issues[${index}] has an invalid Plugin identity`)
	}
	return {
		plugin,
		phase: value.phase as PluginTestLifecycleIssue['phase'],
		kind: value.kind as PluginTestLifecycleIssue['kind'],
		message: value.message,
		...(blockedBy === undefined ? {} : { blockedBy }),
	}
}

function validateFailureSummary(received: unknown): ValidatedFailureSummary {
	if (!isRecord(received) || !isRecord(received.lifecycleReport)) {
		throw usageError('receiver must be a lifecycle failure summary')
	}
	const report = received.lifecycleReport
	if (report.ok !== false || !Array.isArray(report.issues) || report.issues.length === 0) {
		throw usageError('receiver must contain a non-empty failed lifecycle report')
	}
	return {
		lifecycleReport: {
			ok: false,
			issues: report.issues.map(validateIssue) as [
				PluginTestLifecycleIssue,
				...PluginTestLifecycleIssue[],
			],
		},
	}
}

function validateExpectation(value: unknown): PluginLifecycleIssueExpectation {
	if (value === undefined) return {}
	if (!isRecord(value)) throw usageError('expected fields must be an object when provided')
	for (const key of Object.keys(value)) {
		if (!EXPECTATION_KEYS.has(key)) throw usageError(`expected fields contain unknown key ${key}`)
	}
	if (
		value.phase !== undefined &&
		(typeof value.phase !== 'string' || !LIFECYCLE_PHASES.has(value.phase))
	) {
		throw usageError('expected phase must be a lifecycle phase')
	}
	if (
		value.kind !== undefined &&
		(typeof value.kind !== 'string' || !LIFECYCLE_KINDS.has(value.kind))
	) {
		throw usageError('expected kind must be a lifecycle issue kind')
	}
	if (
		value.message !== undefined &&
		typeof value.message !== 'string' &&
		!(value.message instanceof RegExp)
	) {
		throw usageError('expected message must be a string or RegExp')
	}
	if (value.blockedBy !== undefined) targetAddress(value.blockedBy, 'expected blockedBy')
	return value as PluginLifecycleIssueExpectation
}

function matchesMessage(actual: string, expected: string | RegExp | undefined): boolean {
	if (expected === undefined) return true
	if (typeof expected === 'string') return actual.includes(expected)
	expected.lastIndex = 0
	return expected.test(actual)
}

function describeExpectation(
	target: PluginNodeAddress,
	expected: PluginLifecycleIssueExpectation,
): string {
	const fields = [`target: ${formatPluginNodeReference(target)}`]
	if (expected.phase !== undefined) fields.push(`phase: ${expected.phase}`)
	if (expected.kind !== undefined) fields.push(`kind: ${expected.kind}`)
	if (expected.blockedBy !== undefined) {
		fields.push(
			`blockedBy: ${formatPluginNodeReference(targetAddress(expected.blockedBy, 'expected blockedBy'))}`,
		)
	}
	if (typeof expected.message === 'string') fields.push('message: <substring>')
	else if (expected.message instanceof RegExp) fields.push('message: <RegExp>')
	return fields.join(', ')
}

function describeIssues(issues: readonly PluginTestLifecycleIssue[]): string {
	return issues
		.map((issue) => {
			const fields = [
				`target: ${formatPluginNodeReference(issue.plugin)}`,
				`phase: ${issue.phase}`,
				`kind: ${issue.kind}`,
			]
			if (issue.blockedBy) {
				fields.push(`blockedBy: ${formatPluginNodeReference(issue.blockedBy)}`)
			}
			return `  - ${fields.join(', ')}`
		})
		.join('\n')
}

function registerPluginLifecycleMatcher(expectApi: ExpectStatic): void {
	expectApi.extend({
		toHavePluginLifecycleIssue(received, target, expected) {
			const summary = validateFailureSummary(received)
			const targetNode = targetAddress(target, 'target')
			const fields = validateExpectation(expected)
			const blockedBy =
				fields.blockedBy === undefined
					? undefined
					: targetAddress(fields.blockedBy, 'expected blockedBy')
			const pass = summary.lifecycleReport.issues.some((issue) => {
				if (!pluginNodeAddressEqual(issue.plugin, targetNode)) return false
				if (fields.phase !== undefined && issue.phase !== fields.phase) return false
				if (fields.kind !== undefined && issue.kind !== fields.kind) return false
				if (
					blockedBy !== undefined &&
					(issue.blockedBy === undefined || !pluginNodeAddressEqual(issue.blockedBy, blockedBy))
				) {
					return false
				}
				return matchesMessage(issue.message, fields.message)
			})

			const expectation = describeExpectation(targetNode, fields)
			const actual = describeIssues(summary.lifecycleReport.issues)
			return {
				pass,
				message: () =>
					this.isNot
						? `Expected lifecycle failure not to contain an issue matching { ${expectation} }\nActual lifecycle issues:\n${actual}`
						: `Expected lifecycle failure to contain an issue matching { ${expectation} }\nActual lifecycle issues:\n${actual}`,
			}
		},
	})
}

registerPluginLifecycleMatcher(expect)

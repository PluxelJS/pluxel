import type { WorkbenchContentPlan } from '@pluxel/core/internal'
import { parseFormPresentationFields, parseRuntimePortableData } from '../web/validation'
import type { RuntimeJsonObject } from '../web/protocol'
import type {
	WorkbenchContentActionOutcome,
	WorkbenchContentActionPresentation,
	WorkbenchContentDataOutcome,
	WorkbenchContentLoadOutcome,
	WorkbenchContentDataPresentation,
	WorkbenchContentPresentation,
	WorkbenchContentRunOutcome,
	WorkbenchContentValidationIssue,
} from './client-protocol'

export function parseWorkbenchContentPresentation(
	input: unknown,
	plan: WorkbenchContentPlan,
): WorkbenchContentPresentation {
	const record = exact(input, 'Content presentation', ['slots'])
	if (!Array.isArray(record.slots)) malformed('Content presentation slots must be an array')
	if (record.slots.length !== plan.slots.length) {
		malformed('Content presentation does not match its plan')
	}
	const slots = record.slots.map((value, index) => {
		const expected = plan.slots[index]!
		if (expected.kind === 'data') {
			const slot = exact(value, `Content data presentation slot ${index}`, [
				'kind',
				'key',
				'display',
				'field',
			])
			if (slot.kind !== 'data' || slot.key !== expected.key) {
				malformed(`Content presentation slot ${index} does not match its plan`)
			}
			if (slot.display !== expected.display) {
				malformed(`Content data slot ${expected.key} display does not match its plan`)
			}
			const fields = parseFormPresentationFields([slot.field], `Content data slot ${expected.key}`)
			const field = fields[0]
			if (!field || field.name !== expected.key) {
				malformed(`Content data slot ${expected.key} has an invalid field projection`)
			}
			return Object.freeze({
				kind: 'data' as const,
				key: expected.key,
				display: expected.display,
				field,
			}) satisfies WorkbenchContentDataPresentation
		}
		const slot = exact(value, `Content action presentation slot ${index}`, [
			'kind',
			'key',
			'label',
			'input',
			'fields',
			'confirm',
		])
		if (
			slot.kind !== 'action' ||
			slot.key !== expected.key ||
			slot.label !== expected.label ||
			slot.input !== expected.input ||
			slot.confirm !== expected.confirm
		) {
			malformed(`Content action slot ${expected.key} does not match its plan`)
		}
		if (expected.input === 'none') {
			if (slot.fields !== undefined) {
				malformed(`Content action ${expected.key} must not include form fields`)
			}
			return Object.freeze({
				kind: 'action' as const,
				key: expected.key,
				label: expected.label,
				input: 'none' as const,
				...(expected.confirm === undefined ? {} : { confirm: expected.confirm }),
			}) satisfies WorkbenchContentActionPresentation
		}
		return Object.freeze({
			kind: 'action' as const,
			key: expected.key,
			label: expected.label,
			input: expected.input,
			fields: parseFormPresentationFields(slot.fields, `Content action ${expected.key}`),
			...(expected.confirm === undefined ? {} : { confirm: expected.confirm }),
		}) satisfies WorkbenchContentActionPresentation
	})
	return Object.freeze({ slots: Object.freeze(slots) })
}

export function parseWorkbenchContentDataOutcome(input: unknown): WorkbenchContentDataOutcome {
	const record = exact(input, 'Content data outcome', ['sequence', 'ok', 'data', 'code'])
	const sequence = positiveSequence(record.sequence)
	if (record.ok === true) {
		if (record.code !== undefined) malformed('successful Content data includes a failure code')
		const data = parseRuntimePortableData(record.data, 'Content data')
		if (!data || typeof data !== 'object' || Array.isArray(data)) {
			malformed('Content data must be an object')
		}
		return Object.freeze({ sequence, ok: true as const, data: data as RuntimeJsonObject })
	}
	if (record.ok !== false || record.code !== 'load_failed' || record.data !== undefined) {
		malformed('Content data outcome is invalid')
	}
	return Object.freeze({ sequence, ok: false as const, code: 'load_failed' as const })
}

export function parseWorkbenchContentLoadOutcome(input: unknown): WorkbenchContentLoadOutcome {
	if (input && typeof input === 'object') {
		const record = input as Record<string, unknown>
		if (record.ok === false && record.code === 'busy' && Object.keys(record).length === 2) {
			return Object.freeze({ ok: false as const, code: 'busy' as const })
		}
	}
	return parseWorkbenchContentDataOutcome(input)
}

export function parseWorkbenchContentRunOutcome(input: unknown): WorkbenchContentRunOutcome {
	const record = exact(input, 'Content run outcome', ['action', 'data'])
	return Object.freeze({
		action: actionOutcome(record.action),
		data: record.data === null ? null : parseWorkbenchContentDataOutcome(record.data),
	})
}

function actionOutcome(input: unknown): WorkbenchContentActionOutcome {
	const record = exact(input, 'Content action outcome', ['ok', 'code', 'message', 'issues'])
	if (record.ok === true) {
		if (record.code !== undefined || record.issues !== undefined) {
			malformed('successful Content action includes failure fields')
		}
		return Object.freeze({
			ok: true as const,
			...(record.message === undefined ? {} : { message: boundedText(record.message, 'message') }),
		})
	}
	if (record.ok !== false) malformed('Content action outcome has an invalid discriminant')
	if (record.code === 'rejected') {
		if (record.issues !== undefined) malformed('rejected Content action includes validation issues')
		return Object.freeze({
			ok: false as const,
			code: 'rejected' as const,
			message: boundedText(record.message, 'message'),
		})
	}
	if (record.code === 'validation_failed') {
		if (
			record.message !== undefined ||
			!Array.isArray(record.issues) ||
			record.issues.length > 64
		) {
			malformed('Content validation outcome is invalid')
		}
		return Object.freeze({
			ok: false as const,
			code: 'validation_failed' as const,
			issues: Object.freeze(record.issues.map(validationIssue)),
		})
	}
	if (
		record.code !== 'busy' &&
		record.code !== 'unknown_action' &&
		record.code !== 'invalid_input' &&
		record.code !== 'action_failed'
	) {
		malformed('Content action failure code is unsupported')
	}
	if (record.message !== undefined || record.issues !== undefined) {
		malformed('Content action failure includes unsupported details')
	}
	return Object.freeze({ ok: false as const, code: record.code })
}

function validationIssue(input: unknown, index: number): WorkbenchContentValidationIssue {
	const record = exact(input, `Content validation issue ${index}`, ['path', 'message'])
	if (!Array.isArray(record.path) || record.path.length > 32) {
		malformed(`Content validation issue ${index} path is invalid`)
	}
	const path = record.path.map((segment) => {
		if (typeof segment === 'string') return boundedText(segment, 'issue path', 128)
		if (Number.isSafeInteger(segment) && (segment as number) >= 0) return segment as number
		malformed('Content validation issue path segment is invalid')
	})
	return Object.freeze({
		path: Object.freeze(path),
		message: boundedText(record.message, 'issue message'),
	})
}

function positiveSequence(input: unknown): number {
	if (!Number.isSafeInteger(input) || (input as number) < 1) {
		malformed('Content data sequence is invalid')
	}
	return input as number
}

function boundedText(input: unknown, label: string, max = 1_024): string {
	if (typeof input !== 'string' || !input || input.length > max) malformed(`${label} is invalid`)
	return input
}

function exact(input: unknown, label: string, allowed: readonly string[]) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		malformed(`${label} must be an object`)
	}
	const record = input as Record<string, unknown>
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) malformed(`${label} includes unsupported field ${key}`)
	}
	return record
}

function malformed(message: string): never {
	throw new TypeError(`[workbench/client] ${message}`)
}

import {
	matchingUnionBranches,
	parseFormFields,
	unionBranchLiteral,
	type FieldNode,
	type PicklistFieldNode,
} from 'valibot-form'
import type { WorkbenchContentPlan } from '@pluxel/core/internal'
import {
	validateRuntimePortableData,
	parseRuntimePortableData,
} from '@pluxel/services/management/internal'
import type { RuntimeJsonObject } from '@pluxel/services/management/protocol'
import type {
	WorkbenchContentActionOutcome,
	WorkbenchContentActionPresentation,
	WorkbenchContentDataOutcome,
	WorkbenchContentLoadOutcome,
	WorkbenchContentDataPresentation,
	WorkbenchContentPresentation,
	WorkbenchContentRunOutcome,
	WorkbenchContentValidationIssue,
} from './client-protocol.ts'

export function parseWorkbenchContentPresentation(
	input: unknown,
	plan: WorkbenchContentPlan,
): WorkbenchContentPresentation {
	validateRuntimePortableData(input, 'Content presentation')
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
			const label = `Content data slot ${expected.key}`
			const fields = readSlotFields([slot.field], label)
			const field = fields[0]
			if (!field || field.name !== expected.key) {
				malformed(`Content data slot ${expected.key} has an invalid field projection`)
			}
			assertDataField(field, label, expected.display)
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
		const label = `Content action slot ${expected.key}`
		const fields = readSlotFields(slot.fields, label)
		assertActionFields(fields, label)
		return Object.freeze({
			kind: 'action' as const,
			key: expected.key,
			label: expected.label,
			input: expected.input,
			fields,
			...(expected.confirm === undefined ? {} : { confirm: expected.confirm }),
		}) satisfies WorkbenchContentActionPresentation
	})
	return Object.freeze({ slots: Object.freeze(slots) })
}

function readSlotFields(input: unknown, label: string): readonly FieldNode[] {
	try {
		return parseFormFields(input)
	} catch (error) {
		if (error instanceof TypeError) malformed(`${label}: ${error.message}`)
		throw error
	}
}

function assertDataField(field: FieldNode, label: string, display: 'inline' | 'block'): void {
	if (field.kind === 'unsupported' || field.kind === 'union') {
		malformed(`${label} has an unsupported display field at ${field.path}`)
	}
	if (field.kind === 'string' && field.control === 'password') {
		malformed(`${label} must not display a password value at ${field.path}`)
	}
	const collection = field.kind === 'array' || field.kind === 'record' || field.kind === 'object'
	if (collection && display === 'inline')
		malformed(`${label} must use a scalar schema in an inline slot`)
	for (const child of fieldChildren(field)) assertDataField(child, label, 'block')
}

function assertActionFields(fields: readonly FieldNode[], label: string): void {
	for (const field of fields) {
		const unsupported = firstUnsupported(field)
		if (unsupported) malformed(`${label} has an unsupported form field at ${unsupported.path}`)
		if (!field.required) continue
		const blocked = writableRootKey(field.name) ? blockedInput(field) : field
		if (blocked) {
			malformed(`${label} cannot fill required field at ${blocked.path} from an empty draft`)
		}
	}
}

function fieldChildren(field: FieldNode): readonly FieldNode[] {
	switch (field.kind) {
		case 'object':
			return field.fields
		case 'array':
			return field.item ? [field.item] : []
		case 'record':
			return field.value ? [field.value] : []
		case 'union':
			return [
				...field.sharedFields.map((slot) => slot.node),
				...field.branches.flatMap((branch) => branch.fields.map((slot) => slot.node)),
				...(field.discriminatorField ? [field.discriminatorField.node] : []),
			]
		default:
			return []
	}
}

function firstUnsupported(field: FieldNode): FieldNode | undefined {
	if (field.kind === 'unsupported') return field
	for (const child of fieldChildren(field)) {
		const unsupported = firstUnsupported(child)
		if (unsupported) return unsupported
	}
	return undefined
}

/** A top-level field needs a literal string registration, without a parent to bind through. */
function writableRootKey(name: string | undefined): boolean {
	return Boolean(
		name &&
		!/[.[\]]/u.test(name) &&
		!['__proto__', 'prototype', 'constructor'].includes(name) &&
		(!/^(0|[1-9]\d*)$/u.test(name) || String(Number.parseInt(name, 10)) !== name),
	)
}

/** Identify structural gaps before a user can open an action with no initial values. */
function blockedInput(
	field: FieldNode,
	seed?: unknown,
	parentLocked = false,
): FieldNode | undefined {
	const locked = parentLocked || field.meta.hidden || field.meta.readOnly || field.meta.disabled
	if (locked && seed === undefined) return field
	if (field.nullable && (!locked || seed === null)) return undefined
	if (locked && seed === null) return field
	switch (field.kind) {
		case 'boolean':
		case 'number':
		case 'string':
			return locked &&
				(typeof seed !== field.kind || (field.literal !== undefined && field.literal !== seed))
				? field
				: undefined
		case 'object':
			if (locked && (typeof seed !== 'object' || Array.isArray(seed))) return field
			for (const child of field.fields) {
				const value = seedAt(seed, child.name)
				if (!child.required && value === undefined) continue
				const blocked = blockedInput(child, value, locked)
				if (blocked) return blocked
			}
			return undefined
		case 'union': {
			const branches = locked ? matchingUnionBranches(field, seed) : field.branches
			if (branches.length === 0) return field
			let rejected: FieldNode | undefined
			for (const branch of branches) {
				let blocked: FieldNode | undefined
				for (const slot of [...field.sharedFields, ...branch.fields]) {
					if (slot.key === field.discriminator) continue
					const value = slot.replaceValue
						? locked
							? seed
							: (unionBranchLiteral(branch) ?? seed)
						: seedAt(seed, slot.key)
					if (!slot.replaceValue && !slot.node.required && value === undefined) continue
					blocked = blockedInput(slot.node, value, locked)
					if (blocked) break
				}
				// An editable selector offers every branch. A frozen seed only has to fit its active branch.
				if (locked && !blocked) return undefined
				if (!locked && blocked) return blocked
				rejected ??= blocked
			}
			return rejected
		}
		case 'array':
		case 'record': {
			const item = field.kind === 'array' ? field.item : field.value
			if (!item) return field
			const min = field.min ?? 0
			const array = Array.isArray(seed)
			const values =
				seed && typeof seed === 'object' && array === (field.kind === 'array')
					? Object.values(seed)
					: []
			if (locked) {
				if (
					!seed ||
					typeof seed !== 'object' ||
					array !== (field.kind === 'array') ||
					values.length < min ||
					values.length > (field.max ?? Infinity)
				)
					return field
				for (const value of values) {
					const blocked = blockedInput(item, value, true)
					if (blocked) return blocked
				}
				return undefined
			}
			if ((field.max ?? Infinity) < min) return field
			if (min === 0) return undefined
			if (field.kind === 'array' && field.layout === 'picker' && item.kind === 'picklist') {
				// A picker can select each declared raw choice once. Its limit is shared with the control.
				const selected = values.filter((value) => item.options?.some((choice) => choice === value))
				const available = enabledChoices(item).filter((choice) => !selected.includes(choice))
				return (item.max ?? Infinity) < min || selected.length + available.length < min
					? field
					: undefined
			}
			if (values.filter((value) => !blockedInput(item, value)).length >= min) return undefined
			if (field.addable === false) return field
			return blockedInput(item, field.kind === 'array' ? field.defaultItem : undefined)
		}
		case 'picklist': {
			if (seed !== undefined && field.options?.some((value) => value === seed)) return undefined
			if (locked) return field
			return enabledChoices(field).length > 0 ? undefined : field
		}
		default:
			return undefined
	}
}

function enabledChoices(field: PicklistFieldNode): (string | number)[] {
	const disabled = new Set(field.disabled)
	const entries = new Map(field.entries?.map((entry) => [entry.value, entry.disabled]))
	return [...new Set(field.options ?? entries.keys())].filter(
		(value) => !(entries.get(value) ?? disabled.has(value)),
	)
}

function seedAt(seed: unknown, key: string | undefined): unknown {
	return seed && typeof seed === 'object' && key !== undefined && Object.hasOwn(seed, key)
		? (seed as Record<string, unknown>)[key]
		: undefined
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
		if (typeof segment === 'string' && segment.length <= 128) return segment
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

import type { WorkbenchContentPlan } from '@pluxel/core/internal'
import { extractField, extractFormFields, type FieldNode } from 'valibot-form'
import { parseWorkbenchContentPresentation } from '../../workbench/client-validation.ts'
import {
	readWorkbenchContentSlot,
	type WorkbenchContentActionResult,
	type WorkbenchContentSchema,
	type WorkbenchContentSlotMap,
} from '../../workbench/definition.ts'
import type {
	WorkbenchContentActionPresentation,
	WorkbenchContentDataPresentation,
	WorkbenchContentPresentation,
} from '../../workbench/client-protocol.ts'

export type WorkbenchContentActionHandler = (
	input?: unknown,
) => WorkbenchContentActionResult | Promise<WorkbenchContentActionResult>

export type WorkbenchContentContract = Readonly<{
	presentation: WorkbenchContentPresentation
	data: ReadonlyMap<string, WorkbenchContentSchema>
	actions: ReadonlyMap<string, Readonly<{ schema?: WorkbenchContentSchema }>>
}>

export type WorkbenchContentRuntimeBinding = Readonly<{
	load?: () => unknown | Promise<unknown>
	subscribe?: (changed: () => void) => Disposable
	actions?: ReadonlyMap<string, WorkbenchContentActionHandler>
}>

/** Compiles generation-owned schemas into a portable presentation and checks its pinned artifact. */
export function prepareWorkbenchContentContract(
	declarations: WorkbenchContentSlotMap,
	plan: WorkbenchContentPlan,
): WorkbenchContentContract {
	const declaredKeys = Object.keys(declarations).sort()
	const planKeys = plan.slots.map((slot) => slot.key)
	if (!sameStrings(declaredKeys, planKeys)) {
		throw new TypeError('[workbench] Content slots do not match the committed artifact')
	}

	const data = new Map<string, WorkbenchContentSchema>()
	const actions = new Map<string, Readonly<{ schema?: WorkbenchContentSchema }>>()
	const slots = plan.slots.map((slot) => {
		const declaration = readWorkbenchContentSlot(declarations[slot.key]!)
		if (slot.kind === 'data') {
			if (declaration.kind !== 'data') mismatch(slot.key)
			assertDisplaySchema(declaration.schema, `Content data ${slot.key}`, new Set())
			const field = extractField(declaration.schema, { fieldName: slot.key, path: slot.key })
			data.set(slot.key, declaration.schema)
			return Object.freeze({
				kind: 'data' as const,
				key: slot.key,
				display: slot.display,
				field,
			}) satisfies WorkbenchContentDataPresentation
		}

		if (
			declaration.kind !== 'action' ||
			declaration.label !== slot.label ||
			declaration.form !== slot.input ||
			declaration.confirm !== slot.confirm
		) {
			mismatch(slot.key)
		}
		let actionPresentation: WorkbenchContentActionPresentation
		if (slot.input === 'none') {
			if (declaration.input !== undefined) mismatch(slot.key)
			actionPresentation = Object.freeze({
				kind: 'action' as const,
				key: slot.key,
				label: slot.label,
				input: 'none' as const,
				...(slot.confirm === undefined ? {} : { confirm: slot.confirm }),
			})
		} else {
			if (declaration.input === undefined) mismatch(slot.key)
			let fields: readonly FieldNode[]
			try {
				fields = extractFormFields(declaration.input)
			} catch (error) {
				if (error instanceof TypeError) {
					throw new TypeError(`[workbench] Content action ${slot.key}: ${error.message}`, {
						cause: error,
					})
				}
				throw error
			}
			actionPresentation = Object.freeze({
				kind: 'action' as const,
				key: slot.key,
				label: slot.label,
				input: slot.input,
				fields,
				...(slot.confirm === undefined ? {} : { confirm: slot.confirm }),
			})
		}
		actions.set(
			slot.key,
			Object.freeze(declaration.input === undefined ? {} : { schema: declaration.input }),
		)
		return actionPresentation
	})

	return Object.freeze({
		presentation: parseWorkbenchContentPresentation({ slots }, plan),
		data,
		actions,
	})
}

/** Checks the exact factory result before any operation can reach author code. */
export function validateWorkbenchContentBinding(
	contract: WorkbenchContentContract,
	input: unknown,
): WorkbenchContentRuntimeBinding {
	const binding = plainRecord(input, 'Content factory result')
	const expected = [
		...(contract.actions.size === 0 ? [] : ['actions']),
		...(contract.data.size === 0 ? [] : ['load']),
		...(contract.data.size > 0 && Object.hasOwn(binding, 'subscribe') ? ['subscribe'] : []),
	].sort()
	const actual = Object.keys(binding).sort()
	if (!sameStrings(expected, actual)) {
		throw new TypeError(
			`[workbench] Content factory result must contain exactly ${expected.join(', ') || 'no fields'}`,
		)
	}
	const load = binding.load
	if (contract.data.size > 0 && typeof load !== 'function') {
		throw new TypeError('[workbench] Content factory load must be a function')
	}
	const subscribe = binding.subscribe
	if (Object.hasOwn(binding, 'subscribe') && typeof subscribe !== 'function') {
		throw new TypeError('[workbench] Content factory subscribe must be a function')
	}
	let actions: ReadonlyMap<string, WorkbenchContentActionHandler> | undefined
	if (contract.actions.size > 0) {
		const handlers = plainRecord(binding.actions, 'Content action handlers')
		const expectedKeys = [...contract.actions.keys()].sort()
		const actualKeys = Object.keys(handlers).sort()
		if (!sameStrings(expectedKeys, actualKeys)) {
			throw new TypeError('[workbench] Content action handlers must exactly match its action slots')
		}
		const prepared = new Map<string, WorkbenchContentActionHandler>()
		for (const key of expectedKeys) {
			if (typeof handlers[key] !== 'function') {
				throw new TypeError(`[workbench] Content action handler ${key} must be a function`)
			}
			prepared.set(key, handlers[key] as WorkbenchContentActionHandler)
		}
		actions = prepared
	}
	return Object.freeze({
		...(load === undefined ? {} : { load: load as () => unknown | Promise<unknown> }),
		...(subscribe === undefined
			? {}
			: { subscribe: subscribe as (changed: () => void) => Disposable }),
		...(actions === undefined ? {} : { actions }),
	})
}

function assertDisplaySchema(schema: unknown, label: string, seen: Set<object>): void {
	if (!schema || typeof schema !== 'object' || (schema as { kind?: unknown }).kind !== 'schema') {
		throw new TypeError(`${label} must be a Valibot schema`)
	}
	if (seen.has(schema)) throw new TypeError(`${label} must not contain a recursive schema`)
	seen.add(schema)
	try {
		const record = schema as unknown as Record<string, unknown>
		if (record.default !== undefined || record.fallback !== undefined || record.type === 'lazy') {
			throw new TypeError(`${label} must not use defaults or lazy schemas`)
		}
		if (Array.isArray(record.pipe)) {
			let checkedRoot = false
			for (const item of record.pipe) {
				if (!item || typeof item !== 'object') continue
				const { kind } = item as { kind?: unknown }
				if (kind === 'transformation') {
					throw new TypeError(`${label} must not transform display values`)
				}
				if (kind === 'schema' && item !== schema) {
					assertDisplaySchema(item, label, seen)
					if (item === record.pipe[0]) checkedRoot = true
				}
			}
			if (checkedRoot) return
		}
		if (record.type === 'nullable' || record.type === 'readonly') {
			assertDisplaySchema(record.wrapped, label, seen)
			return
		}
		if (
			record.type === 'optional' ||
			record.type === 'undefinedable' ||
			record.type === 'nullish' ||
			record.type === 'undefined'
		) {
			throw new TypeError(`${label} must always produce a portable value`)
		}
		if (record.type === 'object' || record.type === 'strict_object') {
			if (!record.entries || typeof record.entries !== 'object' || Array.isArray(record.entries)) {
				throw new TypeError(`${label} has an invalid object schema`)
			}
			for (const [key, child] of Object.entries(record.entries)) {
				assertDisplaySchema(child, `${label}.${key}`, seen)
			}
			return
		}
		if (record.type === 'array') {
			assertDisplaySchema(record.item, `${label}[]`, seen)
			return
		}
		if (record.type === 'record') {
			const key = record.key as { type?: unknown } | undefined
			if (key?.type !== 'string') throw new TypeError(`${label} record keys must be strings`)
			assertDisplaySchema(key, `${label} key`, seen)
			assertDisplaySchema(record.value, `${label}.*`, seen)
			return
		}
		if (
			record.type !== 'string' &&
			record.type !== 'number' &&
			record.type !== 'boolean' &&
			record.type !== 'picklist' &&
			record.type !== 'literal'
		) {
			throw new TypeError(`${label} uses unsupported display schema type ${String(record.type)}`)
		}
	} finally {
		seen.delete(schema)
	}
}

function mismatch(key: string): never {
	throw new TypeError(`[workbench] Content slot ${key} does not match the committed artifact`)
}

function plainRecord(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(`[workbench] ${label} must be a plain record`)
	}
	const prototype = Object.getPrototypeOf(input)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`[workbench] ${label} must be a plain record`)
	}
	return input as Record<string, unknown>
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index])
}

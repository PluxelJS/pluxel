import type { WorkbenchContentPlan } from '@pluxel/core/internal'
import {
	containsUnsupportedFormField,
	projectDataPresentationField,
	projectFormPresentationFields,
	assertFormPresentationRoot,
} from '../../api/presenters/configPresentation'
import {
	readWorkbenchContentSlot,
	readWorkbenchMarkdownDocument,
	type WorkbenchContentActionResult,
	type WorkbenchContentSchema,
	type WorkbenchMarkdownDocument,
} from '../../workbench/definition'
import type {
	WorkbenchContentActionPresentation,
	WorkbenchContentDataPresentation,
	WorkbenchContentPresentation,
} from '../../workbench/client-protocol'

export type WorkbenchContentActionHandler = (
	input?: unknown,
) => WorkbenchContentActionResult | Promise<WorkbenchContentActionResult>

export type WorkbenchContentContract = Readonly<{
	presentation: WorkbenchContentPresentation
	data: ReadonlyMap<string, WorkbenchContentSchema>
	actions: ReadonlyMap<
		string,
		Readonly<{ schema?: WorkbenchContentSchema; presentation: WorkbenchContentActionPresentation }>
	>
}>

export type WorkbenchContentRuntimeBinding = Readonly<{
	load?: () => unknown | Promise<unknown>
	actions?: ReadonlyMap<string, WorkbenchContentActionHandler>
}>

/** Compiles generation-owned schemas into a portable presentation and checks its pinned artifact. */
export function prepareWorkbenchContentContract(
	document: WorkbenchMarkdownDocument,
	plan: WorkbenchContentPlan,
): WorkbenchContentContract {
	const declarations = readWorkbenchMarkdownDocument(document).slots
	const declaredKeys = Object.keys(declarations).sort()
	const planKeys = plan.slots.map((slot) => slot.key)
	if (!sameStrings(declaredKeys, planKeys)) {
		throw new TypeError('[workbench] Content slots do not match the committed artifact')
	}

	const data = new Map<string, WorkbenchContentSchema>()
	const actions = new Map<
		string,
		Readonly<{ schema?: WorkbenchContentSchema; presentation: WorkbenchContentActionPresentation }>
	>()
	const presentation = plan.slots.map((slot) => {
		const declaration = readWorkbenchContentSlot(declarations[slot.key]!)
		if (slot.kind === 'data') {
			if (declaration.kind !== 'data') mismatch(slot.key)
			const field = projectDataPresentationField(declaration.schema, slot.key, slot.display)
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
			assertFormPresentationRoot(declaration.input, `Content action ${slot.key} input`)
			const fields = projectFormPresentationFields(
				declaration.input,
				`Content action ${slot.key} input`,
			)
			if (containsUnsupportedFormField(fields)) {
				throw new TypeError(`[workbench] Content action ${slot.key} has unsupported form fields`)
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
			Object.freeze({
				...(declaration.input === undefined ? {} : { schema: declaration.input }),
				presentation: actionPresentation,
			}),
		)
		return actionPresentation
	})

	return Object.freeze({
		presentation: Object.freeze({ slots: Object.freeze(presentation) }),
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
		...(actions === undefined ? {} : { actions }),
	})
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

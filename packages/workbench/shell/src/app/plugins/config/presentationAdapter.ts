import type { FieldNode } from 'valibot-form'
export { adaptConfigPresentationFields } from '../../workbench/presentationAdapter'

/**
 * Build a patch containing only renderer-editable fields.
 *
 * Object nodes are merged recursively so an unsupported child always keeps the
 * last server value. Collection and union nodes containing unsupported children
 * are locked by the adapter because their structural edits cannot preserve those
 * children reliably.
 */
export function buildEditableConfigPatch(
	fields: readonly FieldNode[],
	candidate: Record<string, unknown>,
	current: Record<string, unknown>,
): Record<string, unknown> {
	const output: Record<string, unknown> = Object.create(null)
	for (const field of fields) {
		if (!field.name) continue
		const projected = editableValue(field, candidate[field.name], current[field.name])
		if (projected.editable) output[field.name] = projected.value
	}
	return output
}

function editableValue(
	node: FieldNode,
	candidate: unknown,
	current: unknown,
): { editable: true; value: unknown } | { editable: false } {
	if (node.kind === 'unsupported' || node.meta.readOnly || node.meta.disabled) {
		return { editable: false }
	}
	if (node.kind !== 'object') return { editable: true, value: candidate }
	const candidateRecord = plainRecord(candidate)
	const currentRecord = plainRecord(current)
	const output: Record<string, unknown> = { ...currentRecord }
	let editable = false
	for (const child of node.fields) {
		if (!child.name) continue
		const projected = editableValue(child, candidateRecord[child.name], currentRecord[child.name])
		if (!projected.editable) continue
		editable = true
		output[child.name] = projected.value
	}
	return editable ? { editable: true, value: output } : { editable: false }
}

function plainRecord(input: unknown): Record<string, unknown> {
	return input && typeof input === 'object' && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: Object.create(null)
}

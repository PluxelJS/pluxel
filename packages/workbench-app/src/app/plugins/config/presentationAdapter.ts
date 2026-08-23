import type { ConfigPresentationFieldV1 } from '@pluxel/runtime/web'
import type { FieldMeta, FieldNode, UnionBranchField } from 'valibot-form'

/** Convert the public portable DTO into valibot-form's renderer-owned data model. */
export function adaptConfigPresentationFields(
	fields: readonly ConfigPresentationFieldV1[],
): FieldNode[] {
	return fields.map(adaptField)
}

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

function adaptField(node: ConfigPresentationFieldV1): FieldNode {
	const base = {
		...(node.name === undefined ? {} : { name: node.name }),
		path: node.path,
		depth: node.depth,
		meta: adaptMeta(node.meta),
		required: node.required,
	}
	switch (node.kind) {
		case 'string':
			return {
				...base,
				kind: 'string',
				control: node.control,
				...defined('placeholder', node.placeholder),
				...defined('rows', node.rows),
				...defined('minLength', node.minLength),
				...defined('maxLength', node.maxLength),
				...defined('format', node.format),
			}
		case 'number':
			return {
				...base,
				kind: 'number',
				...defined('min', node.min),
				...defined('max', node.max),
				...defined('step', node.step),
				...defined('integer', node.integer),
				...defined('placeholder', node.placeholder),
			}
		case 'boolean':
			return { ...base, kind: 'boolean', control: 'switch' }
		case 'picklist':
			return {
				...base,
				kind: 'picklist',
				control: node.control,
				...defined('options', node.options),
				...defined('entries', node.entries),
				...defined('labels', node.labels),
				...defined('disabled', node.disabled),
				...defined('placeholder', node.placeholder),
				...defined('searchable', node.searchable),
				...defined('clearable', node.clearable),
				...defined('max', node.max),
				...defined('create', node.create),
				...defined('emptyLabel', node.emptyLabel),
			}
		case 'array': {
			const item =
				node.item === undefined ? undefined : node.item === null ? null : adaptField(node.item)
			const meta = lockUnsafeCollection(base.meta, node.item)
			return {
				...base,
				meta,
				kind: 'array',
				...defined('item', item),
				...defined('layout', node.layout),
				...defined('columns', node.columns),
				...defined('disableAutoGrid', node.disableAutoGrid),
				...defined('min', node.min),
				...defined('max', node.max),
				...defined('addable', node.addable),
				...defined('removable', node.removable),
				...defined('reorderable', node.reorderable),
				...defined('itemLabel', node.itemLabel),
				...defined('addLabel', node.addLabel),
				...defined('emptyHint', node.emptyHint),
				...defined('defaultItem', node.defaultItem),
			}
		}
		case 'record': {
			const value =
				node.value === undefined ? undefined : node.value === null ? null : adaptField(node.value)
			const meta = lockUnsafeCollection(base.meta, node.value)
			return {
				...base,
				meta,
				kind: 'record',
				...defined('value', value),
				...defined('layout', node.layout),
				...defined('min', node.min),
				...defined('max', node.max),
				...defined('addable', node.addable),
				...defined('removable', node.removable),
				...defined('reorderable', node.reorderable),
				...defined('editableKey', node.editableKey),
				...defined('key', node.key ? { ...node.key } : undefined),
				...defined('valueMeta', node.valueMeta ? { ...node.valueMeta } : undefined),
				...defined('addLabel', node.addLabel),
				...defined('emptyHint', node.emptyHint),
			}
		}
		case 'object':
			return {
				...base,
				kind: 'object',
				fields: node.fields.map(adaptField),
				...defined('variant', node.variant),
				...defined('columns', node.columns),
				...defined('gap', node.gap),
				...defined('collapsible', node.collapsible),
				...defined('collapsed', node.collapsed),
			}
		case 'union': {
			const unsafe =
				node.branches.some((branch) =>
					branch.fields.some((field) => containsUnsupported(field.node)),
				) ||
				node.sharedFields.some((field) => containsUnsupported(field.node)) ||
				(node.discriminatorField !== undefined && containsUnsupported(node.discriminatorField.node))
			return {
				...base,
				meta: unsafe ? lockedMeta(base.meta) : base.meta,
				kind: 'union',
				branches: node.branches.map((branch) => ({
					key: branch.key,
					...defined('discriminatorValue', branch.discriminatorValue),
					fields: branch.fields.map(adaptBranchField),
				})),
				sharedFields: node.sharedFields.map(adaptBranchField),
				...defined('discriminator', node.discriminator),
				...defined(
					'discriminatorField',
					node.discriminatorField ? adaptBranchField(node.discriminatorField) : undefined,
				),
				control: node.control,
				...defined('labels', node.labels),
				...defined('descriptions', node.descriptions),
				...defined('placeholder', node.placeholder),
				...defined('searchable', node.searchable),
				...defined('expose', node.expose),
				...defined('preserve', node.preserve),
				...defined('compact', node.compact),
			}
		}
		case 'unsupported':
			return {
				...base,
				meta: lockedMeta(base.meta),
				kind: 'unsupported',
				readOnly: true,
				reason: node.reason,
			}
	}
}

function adaptBranchField(input: {
	readonly key: string
	readonly node: ConfigPresentationFieldV1
	readonly replaceValue?: boolean
}): UnionBranchField {
	return {
		key: input.key,
		node: adaptField(input.node),
		...defined('replaceValue', input.replaceValue),
	}
}

function adaptMeta(input: ConfigPresentationFieldV1['meta']): FieldMeta {
	return {
		label: input.label,
		...defined('description', input.description),
		...defined('help', input.help),
		...defined('hint', input.hint),
		...defined('badge', typeof input.badge === 'object' ? { ...input.badge } : input.badge),
		...defined('section', input.section ? { ...input.section } : undefined),
		...defined('layout', input.layout ? { ...input.layout } : undefined),
		...defined('hideLabel', input.hideLabel),
		...defined('hideRequired', input.hideRequired),
		...defined('disabled', input.disabled),
		...defined('readOnly', input.readOnly),
		...defined('hidden', input.hidden),
	}
}

function lockUnsafeCollection(
	meta: FieldMeta,
	child: ConfigPresentationFieldV1 | null | undefined,
): FieldMeta {
	return child && containsUnsupported(child) ? lockedMeta(meta) : meta
}

function lockedMeta(meta: FieldMeta): FieldMeta {
	return {
		...meta,
		readOnly: true,
		hint: meta.hint ?? 'This value is read-only because its structure is not fully portable.',
	}
}

function containsUnsupported(node: ConfigPresentationFieldV1): boolean {
	switch (node.kind) {
		case 'unsupported':
			return true
		case 'array':
			return node.item ? containsUnsupported(node.item) : false
		case 'record':
			return node.value ? containsUnsupported(node.value) : false
		case 'object':
			return node.fields.some(containsUnsupported)
		case 'union':
			return (
				node.branches.some((branch) =>
					branch.fields.some((field) => containsUnsupported(field.node)),
				) ||
				node.sharedFields.some((field) => containsUnsupported(field.node)) ||
				(node.discriminatorField !== undefined && containsUnsupported(node.discriminatorField.node))
			)
		default:
			return false
	}
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

function defined<const K extends string, T>(key: K, value: T | undefined): {} | Record<K, T> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, T>)
}

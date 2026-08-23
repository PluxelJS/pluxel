import { extractFormFields, type FieldMeta, type FieldNode } from 'valibot-form'
import type {
	ConfigPresentationBranchFieldV1,
	ConfigPresentationFieldMetaV1,
	ConfigPresentationFieldV1,
	ConfigPresentationPlanV1,
	RuntimeJsonObject,
	RuntimeJsonValue,
} from '../../web/protocol'
import { parseConfigPresentationPlanV1, parseRuntimePortableData } from '../../web/validation'

type ConfigPresentationSectionInput = Readonly<{
	path: readonly string[]
	fieldName: string
	schema: unknown
	defaults: Record<string, unknown>
}>

/** Compile server-owned schema facts into the versioned browser presentation DTO. */
export function compileConfigPresentationPlanV1(input: {
	fieldName: string
	schema: unknown
	defaults: Record<string, unknown>
	sections: readonly ConfigPresentationSectionInput[]
}): ConfigPresentationPlanV1 {
	return parseConfigPresentationPlanV1({
		version: 1,
		fieldName: input.fieldName,
		defaults: jsonRecord(input.defaults, 'config defaults'),
		fields: fields(input.schema, input.fieldName),
		sections: input.sections.map((section) => ({
			path: section.path,
			fieldName: section.fieldName,
			defaults: jsonRecord(section.defaults, `config defaults at ${section.path.join('.')}`),
			fields: fields(section.schema, section.fieldName),
		})),
	})
}

function fields(schema: unknown, fieldName: string): ConfigPresentationFieldV1[] {
	if (!isPresentationSchema(schema)) {
		return [
			{
				name: fieldName,
				path: fieldName,
				depth: 0,
				meta: { label: fieldName, readOnly: true },
				required: false,
				kind: 'unsupported',
				readOnly: true,
				reason: 'Config schema does not expose a supported presentation structure',
			},
		]
	}
	return extractFormFields(schema).map(projectField)
}

function isPresentationSchema(schema: unknown): schema is Parameters<typeof extractFormFields>[0] {
	return !!schema && typeof schema === 'object' && (schema as { kind?: unknown }).kind === 'schema'
}

function projectField(node: FieldNode): ConfigPresentationFieldV1 {
	const base = {
		...(node.name === undefined ? {} : { name: node.name }),
		path: node.path,
		depth: node.depth,
		meta: projectMeta(node.meta),
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
			const item: ConfigPresentationFieldV1 | null | undefined =
				node.item === undefined ? undefined : node.item === null ? null : projectField(node.item)
			let defaultItem: RuntimeJsonValue | undefined
			if (node.defaultItem !== undefined) {
				try {
					defaultItem = parseRuntimePortableData(
						node.defaultItem,
						`config field ${node.path} defaultItem`,
					) as RuntimeJsonValue
				} catch {
					return unsupported(node, 'Array defaultItem is not portable JSON data')
				}
			}
			return {
				...base,
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
				...defined('defaultItem', defaultItem),
			}
		}
		case 'record': {
			const value: ConfigPresentationFieldV1 | null | undefined =
				node.value === undefined ? undefined : node.value === null ? null : projectField(node.value)
			return {
				...base,
				kind: 'record',
				...defined('value', value),
				...defined('layout', node.layout),
				...defined('min', node.min),
				...defined('max', node.max),
				...defined('addable', node.addable),
				...defined('removable', node.removable),
				...defined('reorderable', node.reorderable),
				...defined('editableKey', node.editableKey),
				...defined('key', node.key),
				...defined('valueMeta', node.valueMeta),
				...defined('addLabel', node.addLabel),
				...defined('emptyHint', node.emptyHint),
			}
		}
		case 'object':
			return {
				...base,
				kind: 'object',
				fields: node.fields.map(projectField),
				...defined('variant', node.variant),
				...defined('columns', node.columns),
				...defined('gap', node.gap),
				...defined('collapsible', node.collapsible),
				...defined('collapsed', node.collapsed),
			}
		case 'union':
			return {
				...base,
				kind: 'union',
				branches: node.branches.map((branch) => ({
					key: branch.key,
					...defined('discriminatorValue', branch.discriminatorValue),
					fields: branch.fields.map(projectBranchField),
				})),
				sharedFields: node.sharedFields.map(projectBranchField),
				...defined('discriminator', node.discriminator),
				...defined(
					'discriminatorField',
					node.discriminatorField ? projectBranchField(node.discriminatorField) : undefined,
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
		case 'unsupported':
			return unsupported(node, node.reason)
	}
}

function unsupported(node: FieldNode, reason: string): ConfigPresentationFieldV1 {
	return {
		...(node.name === undefined ? {} : { name: node.name }),
		path: node.path,
		depth: node.depth,
		meta: { ...projectMeta(node.meta), readOnly: true },
		required: node.required,
		kind: 'unsupported',
		readOnly: true,
		reason,
	}
}

function projectBranchField(input: {
	key: string
	node: FieldNode
	replaceValue?: boolean
}): ConfigPresentationBranchFieldV1 {
	return {
		key: input.key,
		node: projectField(input.node),
		...defined('replaceValue', input.replaceValue),
	}
}

function projectMeta(meta: FieldMeta): ConfigPresentationFieldMetaV1 {
	return {
		label: meta.label,
		...defined('description', meta.description),
		...defined('help', meta.help),
		...defined('hint', meta.hint),
		...defined('badge', meta.badge),
		...defined('section', meta.section),
		...defined('layout', meta.layout),
		...defined('hideLabel', meta.hideLabel),
		...defined('hideRequired', meta.hideRequired),
		...defined('disabled', meta.disabled),
		...defined('readOnly', meta.readOnly),
		...defined('hidden', meta.hidden),
	}
}

function jsonRecord(input: unknown, label: string): RuntimeJsonObject {
	const value = parseRuntimePortableData(input, label)
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${label} must be a JSON object`)
	}
	return value as RuntimeJsonObject
}

function defined<const K extends string, T>(key: K, value: T | undefined): {} | Record<K, T> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, T>)
}

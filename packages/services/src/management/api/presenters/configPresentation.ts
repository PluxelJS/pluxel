import { extractField, extractFormFields, type FieldMeta, type FieldNode } from 'valibot-form'
import type {
	ConfigPresentationBranchFieldV1,
	ConfigPresentationFieldMetaV1,
	ConfigPresentationFieldV1,
	ConfigPresentationPlanV1,
	RuntimeJsonObject,
	RuntimeJsonValue,
} from '../../web/protocol'
import {
	parseConfigPresentationPlanV1,
	parseFormPresentationFields,
	parseRuntimePortableData,
} from '../../web/validation'

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
		fields: projectConfigFields(input.schema, input.fieldName),
		sections: input.sections.map((section) => ({
			path: section.path,
			fieldName: section.fieldName,
			defaults: jsonRecord(section.defaults, `config defaults at ${section.path.join('.')}`),
			fields: projectConfigFields(section.schema, section.fieldName),
		})),
	})
}

function projectConfigFields(schema: unknown, fieldName: string): ConfigPresentationFieldV1[] {
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
	return [...projectFormPresentationFields(schema, `config field ${fieldName}`)]
}

/** @internal Projects a real Valibot object schema into the portable renderer DTO. */
export function projectFormPresentationFields(
	schema: unknown,
	label = 'form schema',
): readonly ConfigPresentationFieldV1[] {
	if (!isPresentationSchema(schema)) {
		throw new TypeError(`${label} must be a Valibot schema`)
	}
	return parseFormPresentationFields(extractFormFields(schema).map(projectField), `${label} fields`)
}

/** @internal Projects one transform-free Valibot display schema for Workbench Content. */
export function projectDataPresentationField(
	schema: unknown,
	key: string,
	display: 'inline' | 'block',
): ConfigPresentationFieldV1 {
	assertDisplaySchema(schema, `Content data ${key}`, new Set())
	const node = extractField(schema as Parameters<typeof extractField>[0], {
		fieldName: key,
		path: key,
		depth: 0,
	})
	if (!node) throw new TypeError(`Content data ${key} has no display field`)
	const field = parseFormPresentationFields([projectField(node)], `Content data ${key}`)[0]!
	assertDisplayField(field, `Content data ${key}`)
	if (
		display === 'inline' &&
		field.kind !== 'string' &&
		field.kind !== 'number' &&
		field.kind !== 'boolean' &&
		field.kind !== 'picklist'
	) {
		throw new TypeError(`Content data ${key} must use a scalar schema in an inline slot`)
	}
	return field
}

/** @internal Content action input must be an object or an intersection of objects. */
export function assertFormPresentationRoot(schema: unknown, label: string): void {
	if (!isPresentationSchema(schema)) throw new TypeError(`${label} must be a Valibot schema`)
	const record = schema as unknown as Record<string, unknown>
	if (record.type === 'object') return
	if (
		record.type === 'intersect' &&
		Array.isArray(record.options) &&
		record.options.length > 0 &&
		record.options.every((option) => isObjectPresentationRoot(option))
	) {
		return
	}
	throw new TypeError(`${label} must be a Valibot object or object intersection`)
}

function isObjectPresentationRoot(schema: unknown): boolean {
	if (!isPresentationSchema(schema)) return false
	const record = schema as unknown as Record<string, unknown>
	return (
		record.type === 'object' ||
		(record.type === 'intersect' &&
			Array.isArray(record.options) &&
			record.options.length > 0 &&
			record.options.every(isObjectPresentationRoot))
	)
}

function assertDisplaySchema(schema: unknown, label: string, seen: Set<object>): void {
	if (!isPresentationSchema(schema)) throw new TypeError(`${label} must be a Valibot schema`)
	if (seen.has(schema)) throw new TypeError(`${label} must not contain a recursive schema`)
	seen.add(schema)
	try {
		const record = schema as unknown as Record<string, unknown>
		if (record.default !== undefined || record.type === 'lazy') {
			throw new TypeError(`${label} must not use defaults or lazy schemas`)
		}
		if (Array.isArray(record.pipe)) {
			for (const item of record.pipe) {
				if (
					item &&
					typeof item === 'object' &&
					(item as { kind?: unknown }).kind === 'transformation'
				) {
					throw new TypeError(`${label} must not transform display values`)
				}
			}
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
		if (record.type === 'object') {
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

function assertDisplayField(field: ConfigPresentationFieldV1, label: string): void {
	if (field.kind === 'unsupported' || field.kind === 'union') {
		throw new TypeError(`${label} has an unsupported display field at ${field.path}`)
	}
	if (field.kind === 'string' && field.control === 'password') {
		throw new TypeError(`${label} must not display a password value`)
	}
	if (field.kind === 'array' && field.item) assertDisplayField(field.item, label)
	if (field.kind === 'record' && field.value) assertDisplayField(field.value, label)
	if (field.kind === 'object') {
		for (const child of field.fields) assertDisplayField(child, label)
	}
}

/** @internal Content actions fail closed instead of degrading unsupported fields to read-only. */
export function containsUnsupportedFormField(
	fields: readonly ConfigPresentationFieldV1[],
): boolean {
	return fields.some(containsUnsupported)
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

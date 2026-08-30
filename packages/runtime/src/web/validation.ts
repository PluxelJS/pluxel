import {
	RUNTIME_MANAGEMENT_CAPABILITIES,
	type ConfigPresentationBranchFieldV1,
	type ConfigPresentationFieldV1,
	type ConfigPresentationFieldMetaV1,
	type ConfigPresentationPlanV1,
	type RuntimeJsonObject,
	type RuntimeJsonValue,
	type RuntimeManagementCapability,
	type RuntimeMetaV1,
} from './protocol'
import { readProductDescriptor } from '../product-contract'

const FIELD_KINDS = new Set([
	'string',
	'number',
	'boolean',
	'picklist',
	'array',
	'record',
	'object',
	'union',
	'unsupported',
])
const MAX_TREE_DEPTH = 32
const MAX_ARRAY_ITEMS = 10_000
const MAX_OBJECT_FIELDS = 10_000
const MAX_TEXT_LENGTH = 1_000_000
const MAX_TOTAL_NODES = 50_000
const MAX_TOTAL_TEXT = 4_000_000

type ValidationBudget = { nodes: number; text: number }

export class RuntimeProtocolValidationError extends TypeError {
	constructor(message: string) {
		super(message)
		this.name = 'RuntimeProtocolValidationError'
	}
}

/** Clone one untrusted wire value into a deeply frozen portable-data tree. */
export function parseRuntimePortableData(input: unknown, label = 'value'): RuntimeJsonValue {
	return clonePortable(input, label, new Set(), 0, { nodes: 0, text: 0 })
}

export function parseConfigFieldPathSegments(
	input: unknown,
	label = 'fieldPath',
): readonly string[] {
	if (typeof input !== 'string') fail(`${label} must be a string`)
	const fieldPath = input.trim()
	if (!fieldPath || fieldPath.length > 512) {
		fail(`${label} must contain between 1 and 512 characters`)
	}
	return pathSegments(fieldPath.split('.'), label, false)
}

/** Validate, clone, and freeze runtime discovery received from an untrusted host. */
export function parseRuntimeMetaV1(input: unknown): RuntimeMetaV1 {
	const meta = record(parseRuntimePortableData(input, 'runtime metadata'), 'runtime metadata')
	exact(meta, ['service', 'ready', 'protocol', 'application', 'workbench'], 'runtime metadata')
	if (meta.service !== 'pluxel-runtime') fail('runtime metadata.service must be pluxel-runtime')
	if (meta.ready !== true) fail('runtime metadata.ready must be true')

	const protocol = record(meta.protocol, 'runtime metadata.protocol')
	exact(protocol, ['name', 'major', 'capabilities'], 'runtime metadata.protocol')
	if (protocol.name !== 'pluxel.management') {
		fail('runtime metadata.protocol.name must be pluxel.management')
	}
	if (protocol.major !== 1) fail('runtime metadata.protocol.major must be 1')
	const capabilities = closedStringArray<RuntimeManagementCapability>(
		protocol.capabilities,
		RUNTIME_MANAGEMENT_CAPABILITIES,
		'runtime metadata.protocol.capabilities',
	)

	const application = record(meta.application, 'runtime metadata.application')
	exact(application, ['product'], 'runtime metadata.application')
	if (!Object.hasOwn(application, 'product')) {
		fail('runtime metadata.application.product is required')
	}
	let product = null
	if (application.product !== null) {
		try {
			product = readProductDescriptor(application.product, 'runtime metadata.application.product')
		} catch (error) {
			fail(
				error instanceof Error ? error.message : 'runtime metadata.application.product is invalid',
			)
		}
	}

	const workbench = record(meta.workbench, 'runtime metadata.workbench')
	exact(workbench, ['enabled'], 'runtime metadata.workbench')
	if (typeof workbench.enabled !== 'boolean') {
		fail('runtime metadata.workbench.enabled must be boolean')
	}

	return Object.freeze({
		service: 'pluxel-runtime' as const,
		ready: true as const,
		protocol: Object.freeze({
			name: 'pluxel.management' as const,
			major: 1 as const,
			capabilities,
		}),
		application: Object.freeze({ product }),
		workbench: Object.freeze({ enabled: workbench.enabled }),
	})
}

/** Validate the serializable config form plan received from a runtime boundary. */
export function parseConfigPresentationPlanV1(input: unknown): ConfigPresentationPlanV1 {
	const plan = record(parseRuntimePortableData(input, 'config presentation plan'), 'plan')
	exact(plan, ['version', 'fieldName', 'defaults', 'fields', 'sections'], 'plan')
	if (plan.version !== 1) fail('plan.version must be 1')
	const fieldName = text(plan.fieldName, 'plan.fieldName')
	const defaults = record(plan.defaults, 'plan.defaults') as RuntimeJsonObject
	const fields = fieldArray(plan.fields, 'plan.fields', 0)
	if (!Array.isArray(plan.sections)) fail('plan.sections must be an array')
	const sections = plan.sections.map((inputSection, index) => {
		const section = record(inputSection, `plan.sections[${index}]`)
		exact(section, ['path', 'fieldName', 'defaults', 'fields'], `plan.sections[${index}]`)
		const path = pathSegments(section.path, `plan.sections[${index}].path`, true)
		return Object.freeze({
			path,
			fieldName: text(section.fieldName, `plan.sections[${index}].fieldName`),
			defaults: record(section.defaults, `plan.sections[${index}].defaults`) as RuntimeJsonObject,
			fields: fieldArray(section.fields, `plan.sections[${index}].fields`, 0),
		})
	})
	return Object.freeze({
		version: 1 as const,
		fieldName,
		defaults,
		fields,
		sections: Object.freeze(sections),
	})
}

function pathSegments(input: unknown, label: string, allowEmpty: boolean): readonly string[] {
	if (!Array.isArray(input)) fail(`${label} must be a string array`)
	if ((!allowEmpty && input.length === 0) || input.length > 32) {
		fail(`${label} must contain ${allowEmpty ? 'between 0 and' : 'between 1 and'} 32 segments`)
	}
	const segments = input.map((item, index) => {
		if (typeof item !== 'string') fail(`${label}[${index}] must be a string`)
		const segment = item.trim()
		if (!segment || segment.length > 128) {
			fail(`${label}[${index}] must contain between 1 and 128 characters`)
		}
		if (segment === '__proto__' || segment === 'prototype' || segment === 'constructor') {
			fail(`${label}[${index}] is reserved`)
		}
		return segment
	})
	if (segments.join('.').length > 512) fail(`${label} exceeds 512 characters`)
	return Object.freeze(segments)
}

function fieldArray(
	input: unknown,
	label: string,
	depth: number,
): readonly ConfigPresentationFieldV1[] {
	if (!Array.isArray(input)) fail(`${label} must be an array`)
	if (input.length > MAX_ARRAY_ITEMS) fail(`${label} exceeds ${MAX_ARRAY_ITEMS} items`)
	return Object.freeze(input.map((item, index) => fieldNode(item, `${label}[${index}]`, depth)))
}

function fieldNode(input: unknown, label: string, depth: number): ConfigPresentationFieldV1 {
	if (depth > MAX_TREE_DEPTH) fail(`${label} exceeds maximum nesting depth`)
	const node = record(input, label)
	if (typeof node.kind !== 'string' || !FIELD_KINDS.has(node.kind)) {
		fail(`${label}.kind is unsupported`)
	}
	const base = fieldBase(node, label, depth)
	switch (node.kind) {
		case 'string':
			exact(
				node,
				[...BASE_FIELDS, 'control', 'placeholder', 'rows', 'minLength', 'maxLength', 'format'],
				label,
			)
			return Object.freeze({
				...base,
				kind: 'string',
				control: enumValue(
					node.control,
					['text', 'textarea', 'password', 'code'],
					`${label}.control`,
				),
				...optionalText(node, 'placeholder', label),
				...optionalNumber(node, 'rows', label),
				...optionalNumber(node, 'minLength', label),
				...optionalNumber(node, 'maxLength', label),
				...optionalText(node, 'format', label),
			})
		case 'number':
			exact(node, [...BASE_FIELDS, 'min', 'max', 'step', 'integer', 'placeholder'], label)
			return Object.freeze({
				...base,
				kind: 'number',
				...optionalNumber(node, 'min', label),
				...optionalNumber(node, 'max', label),
				...optionalNumber(node, 'step', label),
				...optionalBoolean(node, 'integer', label),
				...optionalText(node, 'placeholder', label),
			})
		case 'boolean':
			exact(node, [...BASE_FIELDS, 'control'], label)
			if (node.control !== 'switch') fail(`${label}.control must be switch`)
			return Object.freeze({ ...base, kind: 'boolean', control: 'switch' })
		case 'picklist':
			exact(
				node,
				[
					...BASE_FIELDS,
					'control',
					'options',
					'entries',
					'labels',
					'disabled',
					'placeholder',
					'searchable',
					'clearable',
					'max',
					'create',
					'emptyLabel',
				],
				label,
			)
			return Object.freeze({
				...base,
				kind: 'picklist',
				control: enumValue(node.control, ['select', 'segmented', 'radio'], `${label}.control`),
				...optionalScalarArray(node, 'options', label),
				...optionalPicklistEntries(node, label),
				...optionalStringRecord(node, 'labels', label),
				...optionalScalarArray(node, 'disabled', label),
				...optionalText(node, 'placeholder', label),
				...optionalBoolean(node, 'searchable', label),
				...optionalBoolean(node, 'clearable', label),
				...optionalNumber(node, 'max', label),
				...optionalBoolean(node, 'create', label),
				...optionalText(node, 'emptyLabel', label),
			})
		case 'array': {
			exact(
				node,
				[
					...BASE_FIELDS,
					'item',
					'layout',
					'columns',
					'disableAutoGrid',
					'min',
					'max',
					'addable',
					'removable',
					'reorderable',
					'itemLabel',
					'addLabel',
					'emptyHint',
					'defaultItem',
				],
				label,
			)
			const item =
				node.item === undefined
					? {}
					: {
							item: node.item === null ? null : fieldNode(node.item, `${label}.item`, depth + 1),
						}
			return Object.freeze({
				...base,
				kind: 'array',
				...item,
				...optionalEnum(node, 'layout', ['list', 'grid', 'picker'], label),
				...optionalNumber(node, 'columns', label),
				...optionalBoolean(node, 'disableAutoGrid', label),
				...optionalNumber(node, 'min', label),
				...optionalNumber(node, 'max', label),
				...optionalBoolean(node, 'addable', label),
				...optionalBoolean(node, 'removable', label),
				...optionalBoolean(node, 'reorderable', label),
				...optionalText(node, 'itemLabel', label),
				...optionalText(node, 'addLabel', label),
				...optionalText(node, 'emptyHint', label),
				...(node.defaultItem === undefined
					? {}
					: { defaultItem: node.defaultItem as RuntimeJsonValue }),
			})
		}
		case 'record': {
			exact(
				node,
				[
					...BASE_FIELDS,
					'value',
					'layout',
					'min',
					'max',
					'addable',
					'removable',
					'reorderable',
					'editableKey',
					'key',
					'valueMeta',
					'addLabel',
					'emptyHint',
				],
				label,
			)
			const value =
				node.value === undefined
					? {}
					: {
							value:
								node.value === null ? null : fieldNode(node.value, `${label}.value`, depth + 1),
						}
			return Object.freeze({
				...base,
				kind: 'record',
				...value,
				...optionalEnum(node, 'layout', ['table', 'list'], label),
				...optionalNumber(node, 'min', label),
				...optionalNumber(node, 'max', label),
				...optionalBoolean(node, 'addable', label),
				...optionalBoolean(node, 'removable', label),
				...optionalBoolean(node, 'reorderable', label),
				...optionalBoolean(node, 'editableKey', label),
				...optionalRecordColumn(node, 'key', label),
				...optionalRecordColumn(node, 'valueMeta', label),
				...optionalText(node, 'addLabel', label),
				...optionalText(node, 'emptyHint', label),
			})
		}
		case 'object':
			exact(
				node,
				[...BASE_FIELDS, 'fields', 'variant', 'columns', 'gap', 'collapsible', 'collapsed'],
				label,
			)
			return Object.freeze({
				...base,
				kind: 'object',
				fields: fieldArray(node.fields, `${label}.fields`, depth + 1),
				...optionalEnum(node, 'variant', ['card', 'stack'], label),
				...optionalNumber(node, 'columns', label),
				...optionalNumberOrText(node, 'gap', label),
				...optionalBoolean(node, 'collapsible', label),
				...optionalBoolean(node, 'collapsed', label),
			})
		case 'union': {
			exact(
				node,
				[
					...BASE_FIELDS,
					'branches',
					'sharedFields',
					'discriminator',
					'discriminatorField',
					'control',
					'labels',
					'descriptions',
					'placeholder',
					'searchable',
					'expose',
					'preserve',
					'compact',
				],
				label,
			)
			if (!Array.isArray(node.branches)) fail(`${label}.branches must be an array`)
			const branches = node.branches.map((inputBranch, index) => {
				const branch = record(inputBranch, `${label}.branches[${index}]`)
				exact(branch, ['key', 'discriminatorValue', 'fields'], `${label}.branches[${index}]`)
				const discriminatorValue = branch.discriminatorValue
				if (
					discriminatorValue !== undefined &&
					discriminatorValue !== null &&
					typeof discriminatorValue !== 'string' &&
					typeof discriminatorValue !== 'number' &&
					typeof discriminatorValue !== 'boolean'
				) {
					fail(`${label}.branches[${index}].discriminatorValue is invalid`)
				}
				return Object.freeze({
					key: text(branch.key, `${label}.branches[${index}].key`),
					...(discriminatorValue === undefined
						? {}
						: {
								discriminatorValue: discriminatorValue as string | number | boolean | null,
							}),
					fields: branchFields(branch.fields, `${label}.branches[${index}].fields`, depth + 1),
				})
			})
			return Object.freeze({
				...base,
				kind: 'union',
				branches: Object.freeze(branches),
				sharedFields: branchFields(node.sharedFields, `${label}.sharedFields`, depth + 1),
				...optionalText(node, 'discriminator', label),
				...(node.discriminatorField === undefined
					? {}
					: {
							discriminatorField: branchField(
								node.discriminatorField,
								`${label}.discriminatorField`,
								depth + 1,
							),
						}),
				control: enumValue(
					node.control,
					['select', 'segmented', 'radio', 'switch'],
					`${label}.control`,
				),
				...optionalStringRecord(node, 'labels', label),
				...optionalStringRecord(node, 'descriptions', label),
				...optionalText(node, 'placeholder', label),
				...optionalBoolean(node, 'searchable', label),
				...optionalEnum(node, 'expose', ['auto', 'always', 'never'], label),
				...optionalBoolean(node, 'preserve', label),
				...optionalBoolean(node, 'compact', label),
			})
		}
		case 'unsupported':
			exact(node, [...BASE_FIELDS, 'readOnly', 'reason'], label)
			if (node.readOnly !== true || base.meta.readOnly !== true) {
				fail(`${label} must be read-only when kind is unsupported`)
			}
			return Object.freeze({
				...base,
				kind: 'unsupported',
				readOnly: true,
				reason: text(node.reason, `${label}.reason`),
			})
	}
	fail(`${label}.kind is unsupported`)
}

const BASE_FIELDS = ['kind', 'name', 'path', 'depth', 'meta', 'required'] as const

function fieldBase(input: Record<string, unknown>, label: string, expectedDepth: number) {
	if (!Number.isSafeInteger(input.depth) || input.depth !== expectedDepth) {
		fail(`${label}.depth must equal its traversal depth (${expectedDepth})`)
	}
	if (typeof input.required !== 'boolean') fail(`${label}.required must be boolean`)
	const path = text(input.path, `${label}.path`)
	parseConfigFieldPathSegments(path, `${label}.path`)
	return Object.freeze({
		...(input.name === undefined ? {} : { name: text(input.name, `${label}.name`) }),
		path,
		depth: input.depth as number,
		meta: fieldMeta(input.meta, `${label}.meta`),
		required: input.required,
	})
}

function fieldMeta(input: unknown, label: string): ConfigPresentationFieldMetaV1 {
	const meta = record(input, label)
	exact(
		meta,
		[
			'label',
			'description',
			'help',
			'hint',
			'badge',
			'section',
			'layout',
			'hideLabel',
			'hideRequired',
			'disabled',
			'readOnly',
			'hidden',
		],
		label,
	)
	return Object.freeze({
		label: text(meta.label, `${label}.label`),
		...optionalText(meta, 'description', label),
		...optionalText(meta, 'help', label),
		...optionalText(meta, 'hint', label),
		...optionalBadge(meta, label),
		...optionalSection(meta, label),
		...optionalLayout(meta, label),
		...optionalBoolean(meta, 'hideLabel', label),
		...optionalBoolean(meta, 'hideRequired', label),
		...optionalBoolean(meta, 'disabled', label),
		...optionalBoolean(meta, 'readOnly', label),
		...optionalBoolean(meta, 'hidden', label),
	})
}

function branchFields(
	input: unknown,
	label: string,
	depth: number,
): readonly ConfigPresentationBranchFieldV1[] {
	if (!Array.isArray(input)) fail(`${label} must be an array`)
	return Object.freeze(input.map((item, index) => branchField(item, `${label}[${index}]`, depth)))
}

function branchField(
	input: unknown,
	label: string,
	depth: number,
): ConfigPresentationBranchFieldV1 {
	const item = record(input, label)
	exact(item, ['key', 'node', 'replaceValue'], label)
	if (item.replaceValue !== undefined && typeof item.replaceValue !== 'boolean') {
		fail(`${label}.replaceValue must be boolean`)
	}
	return Object.freeze({
		key: text(item.key, `${label}.key`),
		node: fieldNode(item.node, `${label}.node`, depth),
		...(item.replaceValue === undefined ? {} : { replaceValue: item.replaceValue as boolean }),
	})
}

function optionalText(recordValue: Record<string, unknown>, key: string, label: string) {
	return recordValue[key] === undefined ? {} : { [key]: text(recordValue[key], `${label}.${key}`) }
}

function optionalNumber(recordValue: Record<string, unknown>, key: string, label: string) {
	if (recordValue[key] === undefined) return {}
	const value = recordValue[key]
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		fail(`${label}.${key} must be a finite number`)
	}
	return { [key]: value }
}

function optionalBoolean(recordValue: Record<string, unknown>, key: string, label: string) {
	if (recordValue[key] === undefined) return {}
	if (typeof recordValue[key] !== 'boolean') fail(`${label}.${key} must be boolean`)
	return { [key]: recordValue[key] as boolean }
}

function optionalNumberOrText(recordValue: Record<string, unknown>, key: string, label: string) {
	if (recordValue[key] === undefined) return {}
	const value = recordValue[key]
	if ((typeof value !== 'number' || !Number.isFinite(value)) && typeof value !== 'string') {
		fail(`${label}.${key} must be a finite number or string`)
	}
	return { [key]: value as number | string }
}

function optionalEnum<const T extends string>(
	recordValue: Record<string, unknown>,
	key: string,
	values: readonly T[],
	label: string,
) {
	return recordValue[key] === undefined
		? {}
		: { [key]: enumValue(recordValue[key], values, `${label}.${key}`) }
}

function enumValue<const T extends string>(input: unknown, values: readonly T[], label: string): T {
	if (typeof input !== 'string' || !values.includes(input as T)) {
		fail(`${label} must be one of ${values.join(', ')}`)
	}
	return input as T
}

function optionalScalarArray(recordValue: Record<string, unknown>, key: string, label: string) {
	const input = recordValue[key]
	if (input === undefined) return {}
	if (!Array.isArray(input)) fail(`${label}.${key} must be an array`)
	if (input.length > MAX_ARRAY_ITEMS) fail(`${label}.${key} exceeds ${MAX_ARRAY_ITEMS} items`)
	const output = input.map((item, index) => {
		if (typeof item !== 'string' && (typeof item !== 'number' || !Number.isFinite(item))) {
			fail(`${label}.${key}[${index}] must be a string or finite number`)
		}
		return item as string | number
	})
	return { [key]: Object.freeze(output) }
}

function optionalPicklistEntries(recordValue: Record<string, unknown>, label: string) {
	const input = recordValue.entries
	if (input === undefined) return {}
	if (!Array.isArray(input)) fail(`${label}.entries must be an array`)
	const entries = input.map((raw, index) => {
		const entryLabel = `${label}.entries[${index}]`
		const entry = record(raw, entryLabel)
		exact(entry, ['value', 'label', 'description', 'group', 'disabled', 'accentColor'], entryLabel)
		const value = entry.value
		if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) {
			fail(`${entryLabel}.value must be a string or finite number`)
		}
		return Object.freeze({
			value,
			...optionalText(entry, 'label', entryLabel),
			...optionalText(entry, 'description', entryLabel),
			...optionalText(entry, 'group', entryLabel),
			...optionalBoolean(entry, 'disabled', entryLabel),
			...optionalText(entry, 'accentColor', entryLabel),
		})
	})
	return { entries: Object.freeze(entries) }
}

function optionalStringRecord(recordValue: Record<string, unknown>, key: string, label: string) {
	if (recordValue[key] === undefined) return {}
	const source = record(recordValue[key], `${label}.${key}`)
	const output: Record<string, string> = {}
	for (const [entryKey, value] of Object.entries(source)) {
		defineRecordField(output, entryKey, text(value, `${label}.${key}.${entryKey}`))
	}
	return { [key]: Object.freeze(output) }
}

function optionalRecordColumn(recordValue: Record<string, unknown>, key: string, label: string) {
	if (recordValue[key] === undefined) return {}
	const source = record(recordValue[key], `${label}.${key}`)
	exact(source, ['label', 'placeholder', 'width'], `${label}.${key}`)
	return {
		[key]: Object.freeze({
			...optionalText(source, 'label', `${label}.${key}`),
			...optionalText(source, 'placeholder', `${label}.${key}`),
			...optionalNumberOrText(source, 'width', `${label}.${key}`),
		}),
	}
}

function optionalBadge(meta: Record<string, unknown>, label: string) {
	if (meta.badge === undefined) return {}
	if (typeof meta.badge === 'string') return { badge: meta.badge }
	const badge = record(meta.badge, `${label}.badge`)
	exact(badge, ['label', 'color'], `${label}.badge`)
	return {
		badge: Object.freeze({
			label: text(badge.label, `${label}.badge.label`),
			...optionalText(badge, 'color', `${label}.badge`),
		}),
	}
}

function optionalSection(meta: Record<string, unknown>, label: string) {
	if (meta.section === undefined) return {}
	const section = record(meta.section, `${label}.section`)
	exact(section, ['id', 'title', 'description', 'order', 'columns'], `${label}.section`)
	return {
		section: Object.freeze({
			id: text(section.id, `${label}.section.id`),
			...optionalText(section, 'title', `${label}.section`),
			...optionalText(section, 'description', `${label}.section`),
			...optionalNumber(section, 'order', `${label}.section`),
			...optionalNumber(section, 'columns', `${label}.section`),
		}),
	}
}

function optionalLayout(meta: Record<string, unknown>, label: string) {
	if (meta.layout === undefined) return {}
	const layout = record(meta.layout, `${label}.layout`)
	exact(layout, ['full', 'span', 'align'], `${label}.layout`)
	return {
		layout: Object.freeze({
			...optionalBoolean(layout, 'full', `${label}.layout`),
			...optionalNumber(layout, 'span', `${label}.layout`),
			...optionalEnum(layout, 'align', ['start', 'center', 'end'], `${label}.layout`),
		}),
	}
}

function closedStringArray<const T extends string>(
	input: unknown,
	allowed: readonly T[],
	label: string,
): readonly T[] {
	if (!Array.isArray(input)) fail(`${label} must be an array`)
	const allowedValues = new Set<string>(allowed)
	const seen = new Set<string>()
	const output = input.map((value, index) => {
		if (typeof value !== 'string' || !allowedValues.has(value)) {
			fail(`${label}[${index}] is unsupported`)
		}
		if (seen.has(value)) fail(`${label} contains duplicate value ${value}`)
		seen.add(value)
		return value as T
	})
	return Object.freeze(output)
}

function exact(
	recordValue: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
): void {
	const allowedFields = new Set(allowed)
	const extra = Object.keys(recordValue).filter((key) => !allowedFields.has(key))
	if (extra.length > 0) fail(`${label} contains unsupported field ${extra[0]}`)
}

function clonePortable(
	input: unknown,
	label: string,
	ancestors: Set<object>,
	depth: number,
	budget: ValidationBudget,
): RuntimeJsonValue {
	if (++budget.nodes > MAX_TOTAL_NODES) fail(`${label} exceeds total node budget`)
	if (depth > MAX_TREE_DEPTH * 2) fail(`${label} exceeds maximum nesting depth`)
	if (typeof input === 'string') {
		consumeText(input, label, budget)
		return input
	}
	if (input === null) return null
	if (typeof input === 'boolean') return input
	if (typeof input === 'number') {
		if (!Number.isFinite(input)) fail(`${label} must be a finite number`)
		return input
	}
	if (typeof input !== 'object') fail(`${label} is not portable data`)
	if (ancestors.has(input)) fail(`${label} contains a cycle`)
	ancestors.add(input)
	try {
		if (Array.isArray(input)) {
			if (input.length > MAX_ARRAY_ITEMS) fail(`${label} exceeds ${MAX_ARRAY_ITEMS} items`)
			return Object.freeze(
				input.map((item, index) =>
					clonePortable(item, `${label}[${index}]`, ancestors, depth + 1, budget),
				),
			)
		}
		const prototype = Object.getPrototypeOf(input)
		if (prototype !== Object.prototype && prototype !== null) {
			fail(`${label} must be a plain object`)
		}
		if (Object.getOwnPropertySymbols(input).length > 0) fail(`${label} must not contain symbols`)
		const out: Record<string, unknown> = {}
		const descriptors = Object.entries(Object.getOwnPropertyDescriptors(input))
		if (descriptors.length > MAX_OBJECT_FIELDS) fail(`${label} has too many fields`)
		for (const [key, descriptor] of descriptors) {
			consumeText(key, `${label} key`, budget)
			if (!('value' in descriptor)) fail(`${label}.${key} must be a data property`)
			if (descriptor.value === undefined) fail(`${label}.${key} is not portable data`)
			defineRecordField(
				out,
				key,
				clonePortable(descriptor.value, `${label}.${key}`, ancestors, depth + 1, budget),
			)
		}
		return Object.freeze(out) as RuntimeJsonObject
	} finally {
		ancestors.delete(input)
	}
}

function defineRecordField<Value>(target: Record<string, Value>, key: string, value: Value): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	})
}

function consumeText(input: string, label: string, budget: ValidationBudget): void {
	if (input.length > MAX_TEXT_LENGTH) fail(`${label} exceeds maximum string length`)
	budget.text += input.length
	if (budget.text > MAX_TOTAL_TEXT) fail(`${label} exceeds total text budget`)
}

function record(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		fail(`${label} must be an object`)
	return input as Record<string, unknown>
}

function text(input: unknown, label: string): string {
	if (typeof input !== 'string') fail(`${label} must be a string`)
	return input
}

function fail(message: string): never {
	throw new RuntimeProtocolValidationError(message)
}

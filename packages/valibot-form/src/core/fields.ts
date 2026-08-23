import { DEFAULT_TEXTS } from './constants'
import {
	META_TYPES,
	type ArrayMeta,
	type FormMeta,
	type MetaType,
	type NumberMeta,
	type ObjectMeta,
	type PicklistMeta,
	type RecordMeta,
	type StringMeta,
	type UnionMeta,
} from './meta'
import { readMeta, type Schema } from './schema'
import { isDevelopmentEnvironment } from './utils/environment'
import { collectObjectEntries } from './utils/objectEntries'

export type FieldKind =
	| 'string'
	| 'number'
	| 'boolean'
	| 'picklist'
	| 'array'
	| 'record'
	| 'object'
	| 'union'
	| 'unsupported'

export interface NormalizedSectionMeta {
	id: string
	title?: string
	description?: string
	order?: number
	columns?: number
}

export type FieldMeta = Omit<FormMeta, 'section' | 'label'> & {
	label: string
	section?: NormalizedSectionMeta
}

export interface FieldNodeBase {
	kind: FieldKind
	name?: string
	path: string
	depth: number
	meta: FieldMeta
	required: boolean
}

export interface StringFieldNode extends FieldNodeBase {
	kind: 'string'
	control: NonNullable<StringMeta['control']>
	placeholder?: string
	rows?: number
	minLength?: number
	maxLength?: number
	format?: string
}

export interface NumberFieldNode extends FieldNodeBase {
	kind: 'number'
	min?: number
	max?: number
	step?: number
	integer?: boolean
	placeholder?: string
	format?: Intl.NumberFormatOptions
}

export interface BooleanFieldNode extends FieldNodeBase {
	kind: 'boolean'
	control: 'switch'
}

export interface PicklistFieldNode extends FieldNodeBase {
	kind: 'picklist'
	options?: PicklistMeta['options']
	entries?: PicklistMeta['entries']
	labels?: PicklistMeta['labels']
	disabled?: PicklistMeta['disabled']
	placeholder?: string
	searchable?: boolean
	clearable?: boolean
	max?: number
	create?: boolean
	control: NonNullable<PicklistMeta['control']>
	emptyLabel?: string
}

export interface ArrayFieldNode extends FieldNodeBase {
	kind: 'array'
	item?: FieldNode | null
	layout?: ArrayMeta['layout']
	columns?: number
	disableAutoGrid?: boolean
	min?: number
	max?: number
	addable?: boolean
	removable?: boolean
	reorderable?: boolean
	itemLabel?: string
	addLabel?: string
	emptyHint?: string
	defaultItem?: unknown
}

export interface RecordFieldNode extends FieldNodeBase {
	kind: 'record'
	value?: FieldNode | null
	layout?: RecordMeta['layout']
	min?: number
	max?: number
	addable?: boolean
	removable?: boolean
	reorderable?: boolean
	editableKey?: boolean
	key?: RecordMeta['key']
	valueMeta?: RecordMeta['value']
	addLabel?: string
	emptyHint?: string
}

export interface ObjectFieldNode extends FieldNodeBase {
	kind: 'object'
	fields: FieldNode[]
	variant?: ObjectMeta['variant']
	columns?: number
	gap?: ObjectMeta['gap']
	collapsible?: boolean
	collapsed?: boolean
}

export type DiscriminatorValue = string | number | boolean | null

export interface UnionBranchField {
	key: string
	node: FieldNode
	replaceValue?: boolean
}

export interface UnionBranch {
	key: string
	discriminatorValue?: DiscriminatorValue
	fields: UnionBranchField[]
}

export interface UnionFieldNode extends FieldNodeBase {
	kind: 'union'
	branches: UnionBranch[]
	sharedFields: UnionBranchField[]
	discriminator?: string
	discriminatorField?: UnionBranchField
	control: NonNullable<UnionMeta['control']>
	labels?: UnionMeta['labels']
	descriptions?: UnionMeta['descriptions']
	placeholder?: string
	searchable?: boolean
	expose?: UnionMeta['expose']
	preserve?: boolean
	compact?: boolean
}

export interface UnsupportedFieldNode extends FieldNodeBase {
	kind: 'unsupported'
	readOnly: true
	reason: string
}

export type FieldNode =
	| StringFieldNode
	| NumberFieldNode
	| BooleanFieldNode
	| PicklistFieldNode
	| ArrayFieldNode
	| RecordFieldNode
	| ObjectFieldNode
	| UnionFieldNode
	| UnsupportedFieldNode

type ExtractCtx = {
	fieldName?: string
	path?: string
	depth?: number
}

function normalizeSection(section?: FormMeta['section']): NormalizedSectionMeta | undefined {
	if (!section) return undefined
	if (typeof section === 'string') {
		return { id: section, title: section }
	}
	const id = section.id ?? section.title ?? section.description ?? 'section'
	return { ...section, id }
}

function fieldNameToLabel(fieldName: string): string {
	if (!fieldName) return '未命名字段'
	if (fieldName.includes('_')) {
		return fieldName
			.split('_')
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
			.join(' ')
	}
	return fieldName
		.replaceAll(/([A-Z])/g, ' $1')
		.replace(/^./, (str) => str.toUpperCase())
		.trim()
}

function normalizeBaseMeta(
	meta: FormMeta | undefined,
	fieldName?: string,
	required = true,
): FieldMeta {
	const merged: FormMeta = { ...meta }
	const section = normalizeSection(merged.section)
	const label = merged.label || (fieldName ? fieldNameToLabel(fieldName) : '未命名字段')
	const { section: _omitSection, ...rest } = merged

	return {
		...rest,
		label,
		...(section ? { section } : {}),
		required: rest.required ?? required,
	}
}

function unwrapOptional(schema: Schema): { schema: Schema; required: boolean } {
	let current = schema as any
	let required = true
	while (current && typeof current === 'object') {
		if (current.type === 'optional' || current.type === 'nullable' || current.type === 'nullish') {
			required = false
			current = current.wrapped ?? current.schema ?? current.inner ?? current
			if (current === schema) break
			continue
		}
		break
	}
	return { schema: current as Schema, required }
}

function findExplicitKind(schema: Schema): FieldKind | undefined {
	if (!('pipe' in schema)) return undefined
	for (let i = schema.pipe.length - 1; i >= 0; i--) {
		const item = schema.pipe[i] as { kind?: string; type?: MetaType }
		if (item?.kind === 'metadata' && item.type && item.type !== META_TYPES.FORM) {
			switch (item.type) {
				case META_TYPES.STRING:
				case META_TYPES.NUMBER:
				case META_TYPES.BOOLEAN:
				case META_TYPES.PICKLIST:
				case META_TYPES.ARRAY:
				case META_TYPES.RECORD:
				case META_TYPES.OBJECT:
				case META_TYPES.UNION:
					return item.type
				default:
					break
			}
		}
	}
	return undefined
}

function resolveKind(schema: Schema): FieldKind {
	const explicit = findExplicitKind(schema)
	if (explicit) return explicit
	if (schema.type === 'literal') {
		const literalValue = (schema as any).literal
		if (typeof literalValue === 'string') return 'string'
		if (typeof literalValue === 'number') return 'number'
		if (typeof literalValue === 'boolean') return 'boolean'
	}
	if (schema.type === 'variant') return 'union'
	if (schema.type === 'intersect') {
		const entries = collectObjectEntries(schema)
		if (entries?.length) return 'object'
	}
	switch (schema.type) {
		case 'string':
		case 'number':
		case 'boolean':
		case 'picklist':
		case 'array':
		case 'record':
		case 'object':
		case 'union':
			return schema.type
		default:
			return 'unsupported'
	}
}

function extractStringMeta(schema: Schema): StringMeta {
	const meta: StringMeta = { control: 'text' }
	if (!('pipe' in schema)) return meta
	const validationMap = {
		min_length: 'minLength',
		min_value: 'minLength',
		max_length: 'maxLength',
		max_value: 'maxLength',
	} as const
	const fmtMap = {
		url: 'url',
		email: 'email',
		ip: 'ip',
		ipv4: 'ipv4',
		ipv6: 'ipv6',
		hex_color: 'hex_color',
	} as const
	for (let i = schema.pipe.length - 1; i > 0; i--) {
		const item = schema.pipe[i] as any
		if (item.kind === 'metadata' && item.type === META_TYPES.STRING) {
			Object.assign(meta, item.metadata)
			continue
		}
		if (item.kind !== 'validation') continue
		if (item.type in validationMap) {
			const key = validationMap[item.type as keyof typeof validationMap]
			if (meta[key] === undefined) meta[key] = item.requirement
		} else if (item.type in fmtMap && !meta.format) {
			meta.format = fmtMap[item.type as keyof typeof fmtMap]
		}
	}
	return meta
}

function extractNumberMeta(schema: Schema): NumberMeta {
	const meta: NumberMeta = {}
	if (!('pipe' in schema)) return meta
	const validationKey = {
		min_value: 'min',
		max_value: 'max',
	} as const
	for (let i = schema.pipe.length - 1; i > 0; i--) {
		const item = schema.pipe[i] as any
		if (item.kind === 'metadata' && item.type === META_TYPES.NUMBER) {
			Object.assign(meta, item.metadata)
			continue
		}
		if (item.kind !== 'validation') continue
		if (item.type === 'integer') {
			if (meta.integer === undefined) meta.integer = true
			continue
		}
		if (item.type in validationKey) {
			const key = validationKey[item.type as keyof typeof validationKey]
			if (meta[key] === undefined) meta[key] = item.requirement
		}
	}
	return meta
}

function extractPicklistMeta(schema: Schema): PicklistMeta {
	const meta: PicklistMeta = { control: 'select' }
	if (schema.type === 'picklist') {
		const picklist = schema as Schema & { options?: readonly (string | number)[] }
		if (picklist.options?.length) meta.options = picklist.options
	}
	if (!('pipe' in schema)) return meta
	for (let i = schema.pipe.length - 1; i > 0; i--) {
		const item = schema.pipe[i] as any
		if (item.kind === 'metadata' && item.type === META_TYPES.PICKLIST) {
			Object.assign(meta, item.metadata)
		}
	}
	return meta
}

function extractArrayMeta(schema: Schema): ArrayMeta {
	const meta: ArrayMeta = {}
	if (!('pipe' in schema)) return meta
	for (let i = schema.pipe.length - 1; i > 0; i--) {
		const item = schema.pipe[i] as any
		if (item.kind === 'metadata' && item.type === META_TYPES.ARRAY) {
			Object.assign(meta, item.metadata)
			break
		}
	}
	return meta
}

function extractRecordMeta(schema: Schema): RecordMeta {
	const meta: RecordMeta = {}
	if (!('pipe' in schema)) return meta
	for (let i = schema.pipe.length - 1; i > 0; i--) {
		const item = schema.pipe[i] as any
		if (item.kind === 'metadata' && item.type === META_TYPES.RECORD) {
			Object.assign(meta, item.metadata)
			break
		}
	}
	return meta
}

function extractObjectMeta(schema: Schema): ObjectMeta {
	const meta: ObjectMeta = {}
	if (!('pipe' in schema)) return meta
	for (let i = schema.pipe.length - 1; i > 0; i--) {
		const item = schema.pipe[i] as any
		if (item.kind === 'metadata' && item.type === META_TYPES.OBJECT) {
			Object.assign(meta, item.metadata)
			break
		}
	}
	return meta
}

function extractUnionMeta(schema: Schema): UnionMeta {
	const meta: UnionMeta = { control: 'select', expose: 'auto', preserve: true }
	if (!('pipe' in schema)) return meta
	for (let i = schema.pipe.length - 1; i > 0; i--) {
		const item = schema.pipe[i] as any
		if (item.kind === 'metadata' && item.type === META_TYPES.UNION) {
			Object.assign(meta, item.metadata)
			break
		}
	}
	return meta
}

type UnionSchema = Schema & { type: 'union'; options: readonly Schema[]; pipe?: readonly unknown[] }
type VariantSchema = Schema & {
	type: 'variant'
	key: string
	options: readonly Schema[]
	pipe?: readonly unknown[]
}
type IntersectSchema = Schema & {
	type: 'intersect'
	options: readonly Schema[]
	pipe?: readonly unknown[]
}

const BOOLEANISH = new Set<unknown>([true, false, 'true', 'false', 1, 0, '1', '0'])

function literalLikeValue(schema: Schema): DiscriminatorValue | undefined {
	if (schema.type === 'literal') {
		const literalSchema = schema as Schema & { type: 'literal'; literal: unknown }
		return (literalSchema.literal as DiscriminatorValue) ?? null
	}
	if (schema.type === 'picklist') {
		const picklist = schema as Schema & { options?: readonly (string | number)[] }
		if (picklist.options?.length === 1) {
			return (picklist.options[0] as DiscriminatorValue) ?? null
		}
	}
	return undefined
}

function entriesToMap(schema: Schema): Map<string, Schema> | undefined {
	const entries = collectObjectEntries(schema)
	if (!entries) return undefined
	const map = new Map<string, Schema>()
	for (const entry of entries) map.set(entry.name, entry.schema)
	return map
}

function inferDiscriminatorKey(branches: readonly Schema[]): string | undefined {
	const entryMaps = branches.map((branch) => entriesToMap(branch)).filter(Boolean) as Map<
		string,
		Schema
	>[]
	if (entryMaps.length === 0) return undefined

	const candidate = new Map<string, DiscriminatorValue[]>()
	for (const map of entryMaps) {
		for (const [name, schema] of map.entries()) {
			const value = literalLikeValue(schema)
			if (value === undefined) continue
			const bucket = candidate.get(name) ?? []
			bucket.push(value)
			candidate.set(name, bucket)
		}
	}

	const requiredCount = entryMaps.length
	const validCandidates = Array.from(candidate.entries()).filter(([_, values]) => {
		if (values.length !== requiredCount) return false
		return new Set(values.map((v) => `${v}`)).size === requiredCount
	})
	if (validCandidates.length === 0) return undefined

	const booleanCandidate = validCandidates.find(([_, values]) =>
		values.every((v) => BOOLEANISH.has(v)),
	)
	if (booleanCandidate) return booleanCandidate[0]

	const priority = ['type', 'kind', 'mode', 'enabled']
	for (const key of priority) {
		if (validCandidates.some(([candidateKey]) => candidateKey === key)) return key
	}

	validCandidates.sort(([a], [b]) => a.localeCompare(b))
	return validCandidates[0][0]
}

function extractDiscriminatorValueFromBranch(
	branchSchema: Schema,
	discriminatorKey?: string,
): DiscriminatorValue | undefined {
	if (!discriminatorKey) return undefined
	const entryMap = entriesToMap(branchSchema)
	const discriminatorSchema = entryMap?.get(discriminatorKey)
	if (!discriminatorSchema) return undefined
	return literalLikeValue(discriminatorSchema)
}

function gatherUnionParts(schema: UnionSchema | VariantSchema | IntersectSchema) {
	if (schema.type !== 'intersect') {
		return {
			unionSchema:
				schema.type === 'union' || schema.type === 'variant'
					? (schema as UnionSchema | VariantSchema)
					: undefined,
			sharedObjects: [] as Schema[],
			mode: schema.type,
		}
	}

	const sharedObjects: Schema[] = []
	let unionSchema: UnionSchema | VariantSchema | undefined

	const walk = (node: IntersectSchema) => {
		for (const option of node.options ?? []) {
			if (!(option && typeof option === 'object' && (option as any).kind === 'schema')) continue
			if (!unionSchema && (option.type === 'union' || option.type === 'variant')) {
				unionSchema = option as UnionSchema | VariantSchema
				continue
			}
			if (option.type === 'intersect') {
				walk(option as IntersectSchema)
				continue
			}
			if (option.type === 'object') {
				sharedObjects.push(option)
			}
		}
	}

	walk(schema as IntersectSchema)
	return { unionSchema, sharedObjects, mode: 'intersect' as const }
}

function normalizeBranchKey(value: DiscriminatorValue | undefined, index: number) {
	if (value === null || value === undefined) return `branch_${index}`
	if (typeof value === 'boolean') return value ? 'true' : 'false'
	return String(value)
}

function extractUnionNode(schema: Schema, ctx: ExtractCtx, baseMeta: FieldMeta): UnionFieldNode {
	const meta = extractUnionMeta(schema)
	const { unionSchema, sharedObjects } = gatherUnionParts(schema as any)
	const branchesSource = unionSchema?.options ?? []
	const discriminator =
		meta.discriminator ??
		(branchesSource.length > 0 ? inferDiscriminatorKey(branchesSource) : undefined)

	const sharedFields: UnionBranchField[] = []
	let discriminatorField: UnionBranchField | undefined

	for (const shared of sharedObjects) {
		const entries = collectObjectEntries(shared) ?? []
		for (const entry of entries) {
			if (entry.name === discriminator) {
				if (!discriminatorField) {
					const node = extractField(entry.schema, {
						fieldName: entry.name,
						path: ctx.path ? `${ctx.path}.${entry.name}` : entry.name,
						depth: (ctx.depth ?? 0) + 1,
					})
					if (node) {
						discriminatorField = { key: entry.name, node }
					}
				}
				continue
			}
			const node = extractField(entry.schema, {
				fieldName: entry.name,
				path: ctx.path ? `${ctx.path}.${entry.name}` : entry.name,
				depth: (ctx.depth ?? 0) + 1,
			})
			if (node) sharedFields.push({ key: entry.name, node })
		}
	}

	const branches: UnionBranch[] = branchesSource.map((branchSchema, index) => {
		const discriminatorValue = extractDiscriminatorValueFromBranch(branchSchema, discriminator)
		const branchKey = normalizeBranchKey(discriminatorValue, index)
		const branchEntries = collectObjectEntries(branchSchema)
		if (branchEntries) {
			const fields: UnionBranchField[] = []
			for (const entry of branchEntries) {
				if (entry.name === discriminator) continue
				if (sharedFields.some((f) => f.key === entry.name)) continue
				const node = extractField(entry.schema, {
					fieldName: entry.name,
					path: ctx.path ? `${ctx.path}.${entry.name}` : entry.name,
					depth: (ctx.depth ?? 0) + 1,
				})
				if (node) fields.push({ key: entry.name, node })
			}
			return { key: branchKey, discriminatorValue, fields }
		}

		const fallbackKey =
			ctx.fieldName ||
			discriminator ||
			(baseMeta.label ? baseMeta.label.toLowerCase().replaceAll(/\s+/g, '_') : 'value')
		const node = extractField(branchSchema, {
			fieldName: fallbackKey,
			path: ctx.path,
			depth: (ctx.depth ?? 0) + 1,
		})
		const fields = node ? [{ key: fallbackKey, node, replaceValue: true }] : []
		return { key: branchKey, discriminatorValue, fields }
	})

	return {
		kind: 'union',
		name: ctx.fieldName,
		path: ctx.path ?? '',
		depth: ctx.depth ?? 0,
		meta: baseMeta,
		required: baseMeta.required ?? true,
		branches,
		sharedFields,
		discriminator,
		discriminatorField,
		control: meta.control ?? 'select',
		labels: meta.labels,
		descriptions: meta.descriptions,
		placeholder: meta.placeholder,
		searchable: meta.searchable,
		expose: meta.expose,
		preserve: meta.preserve,
		compact: meta.compact,
	}
}

export function extractField(schema: Schema, ctx: ExtractCtx = {}): FieldNode | null {
	const { schema: unwrapped, required } = unwrapOptional(schema)
	const baseMeta = normalizeBaseMeta(readMeta(unwrapped, META_TYPES.FORM), ctx.fieldName, required)
	const resolvedMeta =
		unwrapped.type === 'literal' &&
		baseMeta.readOnly === undefined &&
		baseMeta.disabled === undefined
			? { ...baseMeta, readOnly: true }
			: baseMeta
	const kind = resolveKind(unwrapped)
	const path = ctx.path ?? ctx.fieldName ?? ''
	const depth = ctx.depth ?? 0

	switch (kind) {
		case 'string': {
			const meta = extractStringMeta(unwrapped)
			return {
				kind: 'string',
				name: ctx.fieldName,
				path,
				depth,
				meta: resolvedMeta,
				required: resolvedMeta.required ?? required,
				control: meta.control ?? 'text',
				placeholder: meta.placeholder,
				rows: meta.rows,
				minLength: meta.minLength,
				maxLength: meta.maxLength,
				format: meta.format,
			}
		}
		case 'number': {
			const meta = extractNumberMeta(unwrapped)
			return {
				kind: 'number',
				name: ctx.fieldName,
				path,
				depth,
				meta: resolvedMeta,
				required: resolvedMeta.required ?? required,
				min: meta.min,
				max: meta.max,
				step: meta.step,
				integer: meta.integer,
				placeholder: meta.placeholder,
				format: meta.format,
			}
		}
		case 'boolean': {
			return {
				kind: 'boolean',
				name: ctx.fieldName,
				path,
				depth,
				meta: resolvedMeta,
				required: resolvedMeta.required ?? required,
				control: 'switch',
			}
		}
		case 'picklist': {
			const meta = extractPicklistMeta(unwrapped)
			return {
				kind: 'picklist',
				name: ctx.fieldName,
				path,
				depth,
				meta: resolvedMeta,
				required: resolvedMeta.required ?? required,
				options: meta.options,
				entries: meta.entries,
				labels: meta.labels,
				disabled: meta.disabled,
				placeholder: meta.placeholder,
				searchable: meta.searchable,
				clearable: meta.clearable,
				max: meta.max,
				create: meta.create,
				control: meta.control ?? 'select',
				emptyLabel: meta.emptyLabel,
			}
		}
		case 'array': {
			const meta = extractArrayMeta(unwrapped)
			const itemSchema = (unwrapped as any).item as Schema | undefined
			const itemNode = itemSchema
				? extractField(itemSchema, {
						fieldName: ctx.fieldName ? `${ctx.fieldName}_item` : 'item',
						path: ctx.path ? `${ctx.path}[]` : 'item',
						depth: depth + 1,
					})
				: null
			return {
				kind: 'array',
				name: ctx.fieldName,
				path,
				depth,
				meta: resolvedMeta,
				required: resolvedMeta.required ?? required,
				item: itemNode,
				layout: meta.layout,
				columns: meta.columns,
				disableAutoGrid: meta.disableAutoGrid,
				min: meta.min,
				max: meta.max,
				addable: meta.addable,
				removable: meta.removable,
				reorderable: meta.reorderable,
				itemLabel: meta.itemLabel,
				addLabel: meta.addLabel,
				emptyHint: meta.emptyHint,
				defaultItem: meta.defaultItem,
			}
		}
		case 'record': {
			const meta = extractRecordMeta(unwrapped)
			const valueSchema = (unwrapped as any).value as Schema | undefined
			const valueNode = valueSchema
				? extractField(valueSchema, {
						fieldName: ctx.fieldName ? `${ctx.fieldName}_value` : 'value',
						path: ctx.path ? `${ctx.path}.*` : 'value',
						depth: depth + 1,
					})
				: null
			return {
				kind: 'record',
				name: ctx.fieldName,
				path,
				depth,
				meta: resolvedMeta,
				required: resolvedMeta.required ?? required,
				value: valueNode,
				layout: meta.layout,
				min: meta.min,
				max: meta.max,
				addable: meta.addable,
				removable: meta.removable,
				reorderable: meta.reorderable,
				editableKey: meta.editableKey,
				key: meta.key,
				valueMeta: meta.value,
				addLabel: meta.addLabel,
				emptyHint: meta.emptyHint,
			}
		}
		case 'object': {
			const meta = extractObjectMeta(unwrapped)
			const entries = collectObjectEntries(unwrapped) ?? []
			const fields = entries
				.map((entry) =>
					extractField(entry.schema, {
						fieldName: entry.name,
						path: ctx.path ? `${ctx.path}.${entry.name}` : entry.name,
						depth: depth + 1,
					}),
				)
				.filter(Boolean) as FieldNode[]
			return {
				kind: 'object',
				name: ctx.fieldName,
				path,
				depth,
				meta: resolvedMeta,
				required: resolvedMeta.required ?? required,
				fields,
				variant: meta.variant,
				columns: meta.columns,
				gap: meta.gap,
				collapsible: meta.collapsible,
				collapsed: meta.collapsed,
			}
		}
		case 'union':
			return extractUnionNode(unwrapped, { ...ctx, path, depth }, resolvedMeta)
		default:
			if (isDevelopmentEnvironment()) {
				console.warn(DEFAULT_TEXTS.errors.extractionFailed(unwrapped.type))
			}
			return {
				kind: 'unsupported',
				name: ctx.fieldName,
				path,
				depth,
				meta: { ...resolvedMeta, readOnly: true },
				required: resolvedMeta.required ?? required,
				readOnly: true,
				reason: `Unsupported schema type: ${unwrapped.type}`,
			}
	}
}

export function extractFormFields(schema: Schema): FieldNode[] {
	const entries = collectObjectEntries(schema) ?? []
	return entries
		.map((entry) =>
			extractField(entry.schema, {
				fieldName: entry.name,
				path: entry.name,
				depth: 0,
			}),
		)
		.filter(Boolean) as FieldNode[]
}

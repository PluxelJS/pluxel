import { readArrayMetadata, readFieldMetadata, type FieldData } from './fieldData'
import {
	META_TYPES,
	type ArrayMeta,
	type FormMeta,
	type ObjectMeta,
	type PicklistMeta,
	type RecordMeta,
	type StringMeta,
	type UnionMeta,
} from './meta'
import { readMeta, type Schema } from './schema'
import { readStandardSchemaMetadata, type StandardSchemaMetadata } from './schemaMetadata'
import {
	collectRawValidationActions,
	isSchema,
	pipeRoot,
	type SchemaRecord,
} from './schemaStructure'
import { collectObjectEntries, type ObjectEntry } from './utils/objectEntries'

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
	readonly id: string
	readonly title?: string
	readonly description?: string
	readonly order?: number
	readonly columns?: number
}

export type FieldMeta = Readonly<
	Omit<FormMeta, 'title' | 'description' | 'section' | 'badge' | 'layout'>
> & {
	readonly badge?: string | Readonly<Exclude<FormMeta['badge'], string>>
	readonly layout?: Readonly<FormMeta['layout']>
	readonly label: string
	readonly description?: string
	readonly section?: NormalizedSectionMeta
}

export interface FieldNodeBase {
	readonly kind: FieldKind
	readonly name?: string
	readonly path: string
	readonly depth: number
	readonly meta: FieldMeta
	readonly required: boolean
	readonly nullable: boolean
}

export interface StringFieldNode extends FieldNodeBase {
	readonly kind: 'string'
	readonly literal?: string
	readonly control: NonNullable<StringMeta['control']>
	readonly placeholder?: string
	readonly rows?: number
	readonly minLength?: number
	readonly maxLength?: number
	readonly format?: string
}

export interface NumberFieldNode extends FieldNodeBase {
	readonly kind: 'number'
	readonly literal?: number
	readonly min?: number
	readonly max?: number
	readonly step?: number
	readonly integer?: boolean
	readonly placeholder?: string
	readonly format?: Readonly<Intl.NumberFormatOptions>
}

export interface BooleanFieldNode extends FieldNodeBase {
	readonly kind: 'boolean'
	readonly literal?: boolean
	readonly control: 'switch'
}

export interface PicklistFieldNode extends FieldNodeBase {
	readonly kind: 'picklist'
	readonly options?: readonly (string | number)[]
	readonly entries?: readonly Readonly<NonNullable<PicklistMeta['entries']>[number]>[]
	readonly labels?: Readonly<PicklistMeta['labels']>
	readonly disabled?: PicklistMeta['disabled']
	readonly placeholder?: string
	readonly searchable?: boolean
	readonly clearable?: boolean
	readonly max?: number
	readonly create?: boolean
	readonly control: NonNullable<PicklistMeta['control']>
	readonly emptyLabel?: string
}

export interface ArrayFieldNode extends FieldNodeBase {
	readonly kind: 'array'
	readonly item?: FieldNode | null
	readonly layout?: ArrayMeta['layout']
	readonly columns?: number
	readonly disableAutoGrid?: boolean
	readonly min?: number
	readonly max?: number
	readonly addable?: boolean
	readonly removable?: boolean
	readonly reorderable?: boolean
	readonly itemLabel?: string
	readonly addLabel?: string
	readonly emptyHint?: string
	readonly defaultItem?: FieldData
}

export interface RecordFieldNode extends FieldNodeBase {
	readonly kind: 'record'
	readonly value?: FieldNode | null
	readonly layout?: RecordMeta['layout']
	readonly min?: number
	readonly max?: number
	readonly addable?: boolean
	readonly removable?: boolean
	readonly reorderable?: boolean
	readonly editableKey?: boolean
	readonly key?: Readonly<RecordMeta['key']>
	readonly valueMeta?: Readonly<RecordMeta['value']>
	readonly addLabel?: string
	readonly emptyHint?: string
}

export interface ObjectFieldNode extends FieldNodeBase {
	readonly kind: 'object'
	readonly fields: readonly FieldNode[]
	readonly variant?: ObjectMeta['variant']
	readonly columns?: number
	readonly gap?: ObjectMeta['gap']
	readonly collapsible?: boolean
	readonly collapsed?: boolean
}

export type DiscriminatorValue = string | number | boolean | null

export interface UnionBranchField {
	readonly key: string
	readonly node: FieldNode
	readonly replaceValue?: boolean
}

export interface UnionBranch {
	readonly key: string
	readonly discriminatorValue?: DiscriminatorValue
	readonly fields: readonly UnionBranchField[]
}

export interface UnionFieldNode extends FieldNodeBase {
	readonly kind: 'union'
	readonly branches: readonly UnionBranch[]
	readonly sharedFields: readonly UnionBranchField[]
	readonly discriminator?: string
	readonly discriminatorField?: UnionBranchField
	readonly control: NonNullable<UnionMeta['control']>
	readonly labels?: Readonly<UnionMeta['labels']>
	readonly descriptions?: Readonly<UnionMeta['descriptions']>
	readonly placeholder?: string
	readonly searchable?: boolean
	readonly expose?: UnionMeta['expose']
	readonly preserve?: boolean
	readonly compact?: boolean
}

export interface UnsupportedFieldNode extends FieldNodeBase {
	readonly kind: 'unsupported'
	readonly readOnly: true
	readonly reason: string
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
	if (section === undefined) return undefined
	if (typeof section === 'string') return { id: section, title: section }
	return { ...section, id: section.id ?? section.title ?? section.description ?? 'section' }
}

function fieldNameToLabel(fieldName: string): string {
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
	meta: FormMeta,
	standard: StandardSchemaMetadata,
	fieldName?: string,
): FieldMeta {
	const { title: _title, description: _description, section, ...rest } = meta
	return {
		...rest,
		label: standard.title ?? (fieldName ? fieldNameToLabel(fieldName) : '未命名字段'),
		...(standard.description !== undefined ? { description: standard.description } : {}),
		...(section === undefined ? {} : { section: normalizeSection(section) }),
	}
}

const optionalEntry = new Set(['optional', 'exact_optional', 'nullish'])
const wrappers = new Set([
	...optionalEntry,
	'nullable',
	'undefinedable',
	'non_optional',
	'non_nullable',
	'non_nullish',
])

function inputSchema(schema: Schema): SchemaRecord {
	const seen = new Set<Schema>()
	let current = pipeRoot(schema)
	while (wrappers.has(current.type) && isSchema(current.wrapped) && !seen.has(current)) {
		seen.add(current)
		current = pipeRoot(current.wrapped)
	}
	return current
}

function acceptsNull(schema: Schema, ancestors = new Set<Schema>()): boolean {
	if (ancestors.has(schema)) return false
	const current = pipeRoot(schema)
	if (
		current.type === 'nullable' ||
		current.type === 'nullish' ||
		current.type === 'null' ||
		current.type === 'unknown' ||
		current.type === 'any'
	) {
		return true
	}
	if (current.type === 'non_nullable' || current.type === 'non_nullish') return false
	if (current.type === 'literal') return current.literal === null
	if (current.type === 'picklist' || current.type === 'enum')
		return current.options?.includes(null) === true
	ancestors.add(schema)
	try {
		const includesNull = (option: unknown) => isSchema(option) && acceptsNull(option, ancestors)
		if (current.type === 'union') return current.options?.some(includesNull) ?? false
		if (current.type === 'intersect') return current.options?.every(includesNull) ?? false
		return isSchema(current.wrapped) && acceptsNull(current.wrapped, ancestors)
	} finally {
		ancestors.delete(schema)
	}
}

function fieldBase(schema: Schema, ctx: ExtractCtx): Omit<FieldNodeBase, 'kind'> {
	const path = ctx.path ?? ctx.fieldName ?? ''
	const meta = readFieldMetadata('form', readMeta(schema, META_TYPES.FORM), path)
	const declared = schema as SchemaRecord & { fallback?: unknown }
	return {
		...(ctx.fieldName === undefined ? {} : { name: ctx.fieldName }),
		path,
		depth: ctx.depth ?? 0,
		meta: normalizeBaseMeta(meta, readStandardSchemaMetadata(schema), ctx.fieldName),
		required: !optionalEntry.has(declared.type) && declared.fallback === undefined,
		nullable: acceptsNull(schema),
	}
}

function unsupported(base: Omit<FieldNodeBase, 'kind'>, reason: string): UnsupportedFieldNode {
	return {
		...base,
		kind: 'unsupported',
		meta: { ...base.meta, readOnly: true },
		readOnly: true,
		reason,
	}
}

type Validation = Readonly<Record<string, unknown>>

function bounds(
	actions: readonly Validation[],
	minType: string,
	maxType: string,
	exactType?: string,
): { min?: number; max?: number } {
	let min: number | undefined
	let max: number | undefined
	for (const { type, requirement } of actions) {
		if (typeof requirement !== 'number' || !Number.isFinite(requirement)) continue
		if (type === minType || type === exactType) min = Math.max(min ?? -Infinity, requirement)
		if (type === maxType || type === exactType) max = Math.min(max ?? Infinity, requirement)
	}
	return { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) }
}

const stringFormats = new Set(['url', 'email', 'ip', 'ipv4', 'ipv6', 'hex_color'])

function stringConstraints(validations: readonly Validation[]) {
	const { min, max } = bounds(validations, 'min_length', 'max_length', 'length')
	const format = validations.findLast((action) => stringFormats.has(action.type as string))?.type
	return {
		...(min === undefined ? {} : { minLength: min }),
		...(max === undefined ? {} : { maxLength: max }),
		...(typeof format === 'string' ? { format } : {}),
	}
}

function childContext(fieldName: string, parentPath: string, depth: number): ExtractCtx {
	return { fieldName, path: parentPath ? `${parentPath}.${fieldName}` : fieldName, depth }
}

function extractObjectEntry(entry: ObjectEntry, ctx: ExtractCtx): FieldNode {
	if (entry.duplicate) {
		return unsupported(
			fieldBase(entry.schema, ctx),
			`Intersection contains duplicate key ${JSON.stringify(entry.name)}`,
		)
	}
	return extractField(entry.schema, ctx)
}

function isDiscriminatorValue(input: unknown): input is DiscriminatorValue {
	return (
		input === null ||
		typeof input === 'string' ||
		typeof input === 'boolean' ||
		(typeof input === 'number' && Number.isFinite(input))
	)
}

function discriminatorValues(schema: Schema, ancestors = new Set<Schema>()): DiscriminatorValue[] {
	if (ancestors.has(schema)) return []
	const current = pipeRoot(schema)
	if (current.type === 'literal')
		return isDiscriminatorValue(current.literal) ? [current.literal] : []
	if (current.type === 'null') return [null]
	if (current.type === 'picklist' || current.type === 'enum') {
		return current.options?.every(isDiscriminatorValue) ? [...new Set(current.options)] : []
	}
	if (current.type === 'union' && current.options) {
		ancestors.add(schema)
		try {
			const values = new Set<DiscriminatorValue>()
			for (const member of current.options) {
				const choices = isSchema(member) ? discriminatorValues(member, ancestors) : []
				if (choices.length === 0) return []
				for (const value of choices) values.add(value)
			}
			return [...values]
		} finally {
			ancestors.delete(schema)
		}
	}
	return []
}

function discriminatorEntry(entries: readonly ObjectEntry[] | undefined, key: string) {
	return entries?.find((entry) => entry.name === key && !entry.duplicate)?.schema
}

const booleanish = new Set<unknown>([true, false, 'true', 'false', 1, 0, '1', '0'])

function inferDiscriminatorKey(branches: readonly (readonly ObjectEntry[] | undefined)[]) {
	const first = branches[0]
	if (!first || branches.length < 2) return undefined
	const possibilities = first.flatMap(({ name }) => {
		const values = branches.map((entries) => {
			const entry = discriminatorEntry(entries, name)
			return entry ? discriminatorValues(entry) : []
		})
		if (values.some((choices) => choices.length !== 1)) return []
		const candidates = values.map(([value]) => value)
		return new Set(candidates).size === branches.length ? [{ name, values: candidates }] : []
	})

	return (
		possibilities.find((possibility) => possibility.values.every((value) => booleanish.has(value)))
			?.name ??
		['type', 'kind', 'mode', 'enabled'].find((key) =>
			possibilities.some(({ name }) => name === key),
		) ??
		possibilities.map(({ name }) => name).sort()[0]
	)
}

type BranchSchema = { schema: Schema; entries?: readonly ObjectEntry[] }

function variantBranches(schema: SchemaRecord, ancestors = new Set<Schema>()): BranchSchema[] {
	if (ancestors.has(schema)) return []
	ancestors.add(schema)
	try {
		return (schema.options ?? []).filter(isSchema).flatMap((option) => {
			if (option.type === 'variant') return variantBranches(option, ancestors)
			return [{ schema: option, entries: collectObjectEntries(option) }]
		})
	} finally {
		ancestors.delete(schema)
	}
}

function extractUnionNode(
	schema: SchemaRecord,
	metadataSource: Schema,
	base: Omit<FieldNodeBase, 'kind'>,
): UnionFieldNode | UnsupportedFieldNode {
	const { discriminator: hintedDiscriminator, ...meta } = readFieldMetadata(
		'union',
		readMeta(metadataSource, META_TYPES.UNION),
		base.path,
	)
	const declaredDiscriminator =
		schema.type === 'variant' ? (schema as SchemaRecord & { key: string }).key : undefined
	if (
		declaredDiscriminator !== undefined &&
		hintedDiscriminator !== undefined &&
		declaredDiscriminator !== hintedDiscriminator
	) {
		throw new TypeError(
			`${base.path || 'field'}.unionMeta.discriminator must match the declared variant key ${JSON.stringify(declaredDiscriminator)}`,
		)
	}
	const source =
		declaredDiscriminator === undefined
			? (schema.options ?? []).filter(isSchema).map((option) => ({
					schema: option,
					entries: collectObjectEntries(option),
				}))
			: variantBranches(schema)
	const discriminator =
		declaredDiscriminator ??
		hintedDiscriminator ??
		inferDiscriminatorKey(source.map((branch) => branch.entries))
	const branches: UnionBranch[] = []
	const values = new Set<DiscriminatorValue>()
	const keys = new Set<string>()
	if (source.length === 0) return unsupported(base, 'The union has no editable branches')
	for (const branch of source) {
		const discriminatorSchema =
			discriminator === undefined ? undefined : discriminatorEntry(branch.entries, discriminator)
		const choices = discriminatorSchema ? discriminatorValues(discriminatorSchema) : []
		if (discriminator !== undefined && choices.length === 0) {
			if (declaredDiscriminator !== undefined) {
				return unsupported(
					base,
					`Variant key ${JSON.stringify(declaredDiscriminator)} has an unprojectable option`,
				)
			}
			throw new TypeError(
				`${base.path || 'field'}.unionMeta.discriminator must identify a finite input value for every branch`,
			)
		}
		const depth = base.depth + 1
		const fields = branch.entries
			? branch.entries.flatMap((entry) =>
					entry.name === discriminator
						? []
						: [
								{
									key: entry.name,
									node: extractObjectEntry(entry, childContext(entry.name, base.path, depth)),
								},
							],
				)
			: [
					{
						key: base.name ?? 'value',
						node: extractField(branch.schema, {
							fieldName: base.name ?? 'value',
							path: base.path,
							depth,
						}),
						replaceValue: true,
					},
				]
		for (const value of choices.length > 0 ? choices : [undefined]) {
			if (value !== undefined && values.has(value) && discriminator !== undefined) {
				return unsupported(
					base,
					`Discriminator ${JSON.stringify(discriminator)} has ambiguous branch values`,
				)
			}
			if (value !== undefined) values.add(value)
			const preferred = value == null ? `branch_${branches.length}` : String(value)
			let key = preferred
			for (let suffix = 1; keys.has(key); suffix++) key = `${preferred}_${suffix}`
			keys.add(key)
			branches.push({ key, ...(value === undefined ? {} : { discriminatorValue: value }), fields })
		}
	}

	return {
		...base,
		kind: 'union',
		branches,
		sharedFields: [],
		...(discriminator === undefined ? {} : { discriminator }),
		control: 'select',
		expose: 'auto',
		preserve: true,
		...meta,
	}
}

export function extractField(schema: Schema, ctx: ExtractCtx = {}): FieldNode {
	const input = inputSchema(schema)
	const base = fieldBase(schema, ctx)
	const { path, depth } = base
	const literal = input.type === 'literal' ? input.literal : undefined
	const kind = input.type === 'literal' ? typeof literal : input.type
	const presentation =
		input.type === 'literal' ? { ...base, meta: { ...base.meta, readOnly: true } } : base
	const validations = () => collectRawValidationActions(schema).actions

	switch (kind) {
		case 'string':
			return {
				...presentation,
				kind,
				...(typeof literal === 'string' ? { literal } : {}),
				control: 'text',
				...readFieldMetadata('string', readMeta(schema, META_TYPES.STRING), path),
				...stringConstraints(validations()),
			}
		case 'number': {
			if (typeof literal === 'number' && !Number.isFinite(literal)) {
				return unsupported(presentation, 'The number literal is not finite')
			}
			const actions = validations()
			return {
				...presentation,
				kind,
				...(typeof literal === 'number' ? { literal } : {}),
				...readFieldMetadata('number', readMeta(schema, META_TYPES.NUMBER), path),
				...bounds(actions, 'min_value', 'max_value'),
				...(actions.some((action) => action.type === 'integer') ? { integer: true } : {}),
			}
		}
		case 'boolean':
			return {
				...presentation,
				kind,
				control: 'switch',
				...(typeof literal === 'boolean' ? { literal } : {}),
			}
		case 'picklist': {
			const choices = input.options?.filter(
				(value): value is string | number =>
					typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)),
			)
			if (choices?.length !== input.options?.length) {
				return unsupported(base, 'The picklist contains a non-portable choice')
			}
			return {
				...base,
				kind,
				control: 'select',
				...readFieldMetadata('picklist', readMeta(schema, META_TYPES.PICKLIST), path),
				...(choices === undefined ? {} : { options: choices }),
			}
		}
		case 'array': {
			const { options, reason } = readArrayMetadata(readMeta(schema, META_TYPES.ARRAY), path)
			if (reason) return unsupported(base, reason)
			return {
				...base,
				kind,
				item: input.item
					? extractField(input.item, {
							fieldName: base.name ? `${base.name}_item` : 'item',
							path: path ? `${path}[]` : 'item',
							depth: depth + 1,
						})
					: null,
				...options,
				...bounds(validations(), 'min_length', 'max_length', 'length'),
			}
		}
		case 'record': {
			const { value: valueMeta, ...options } = readFieldMetadata(
				'record',
				readMeta(schema, META_TYPES.RECORD),
				path,
			)
			return {
				...base,
				kind,
				value: input.value
					? extractField(input.value, {
							fieldName: base.name ? `${base.name}_value` : 'value',
							path: path ? `${path}.*` : 'value',
							depth: depth + 1,
						})
					: null,
				...(valueMeta === undefined ? {} : { valueMeta }),
				...options,
				...bounds(validations(), 'min_entries', 'max_entries', 'entries'),
			}
		}
		case 'object':
		case 'strict_object':
		case 'intersect': {
			const entries = collectObjectEntries(input)
			if (!entries) return unsupported(base, `Unsupported object schema type: ${input.type}`)
			return {
				...base,
				kind: 'object',
				...readFieldMetadata('object', readMeta(schema, META_TYPES.OBJECT), path),
				fields: entries.map((entry) =>
					extractObjectEntry(entry, childContext(entry.name, path, depth + 1)),
				),
			}
		}
		case 'union':
		case 'variant':
			return extractUnionNode(input, schema, base)
		default:
			return unsupported(base, `Unsupported schema type: ${input.type}`)
	}
}

export function extractFormFields(schema: Schema): readonly FieldNode[] {
	const entries = collectObjectEntries(schema)
	if (!entries) {
		throw new TypeError(
			'Form root must be an object, a strict object, or an intersection of those schemas',
		)
	}
	return entries.map((entry) => extractObjectEntry(entry, childContext(entry.name, '', 0)))
}

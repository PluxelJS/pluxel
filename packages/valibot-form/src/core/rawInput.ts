import type { Schema } from './schema'
import { readStandardSchemaMetadata } from './schemaMetadata'

/** The only string transports a host needs in order to produce Valibot raw input. */
export type RawInputTransport = 'string' | 'number' | 'boolean' | 'json'

/** A portable description of the target's raw, pre-transform input kind. */
export type RawInputKind =
	| 'string'
	| 'number'
	| 'boolean'
	| 'null'
	| 'array'
	| 'tuple'
	| 'object'
	| 'record'
	| 'union'

export type RawInputChoice = string | number | boolean | null

/**
 * Constraints that can be stated without executing a schema action.
 *
 * The values describe the raw input side of the schema. Omitted properties are
 * unknown, not unconstrained promises made by this projector.
 */
export interface RawInputRange {
	readonly finite?: true
	readonly integer?: true
	readonly minimum?: number
	readonly maximum?: number
	readonly multipleOf?: number
	readonly minLength?: number
	readonly maxLength?: number
}

export interface RawInputProjection {
	readonly ok: true
	readonly path: readonly string[]
	readonly transport: RawInputTransport
	readonly inputKind: RawInputKind
	/** A complete, portable phrase such as `number (finite integer, >= 1)`. */
	readonly inputDescription: string
	/**
	 * Schema descriptions or titles, deduplicated and sorted. When neither is
	 * present, the raw path is the single fallback description.
	 */
	readonly descriptions: readonly string[]
	readonly format?: string
	readonly range?: Readonly<RawInputRange>
	readonly choices?: readonly RawInputChoice[]
	/** Whether every accepted present raw input is represented by a plain JSON object. */
	readonly expectsPlainObject: boolean
}

export type RawInputProjectionFailureKind =
	| 'path_not_found'
	| 'ambiguous_path'
	| 'unsupported_schema'

export interface RawInputProjectionFailure {
	readonly ok: false
	readonly kind: RawInputProjectionFailureKind
	readonly path: readonly string[]
	/** Human-readable diagnostic that never contains an input value or schema default. */
	readonly reason: string
	readonly schemaType?: string
}

export type RawInputProjectionResult = RawInputProjection | RawInputProjectionFailure

type SchemaRecord = Schema & {
	readonly kind: 'schema'
	readonly type: string
	readonly pipe?: readonly unknown[]
	readonly wrapped?: Schema
	readonly entries?: Readonly<Record<string, Schema>>
	readonly item?: Schema
	readonly items?: readonly Schema[]
	readonly rest?: Schema
	readonly value?: Schema
	readonly literal?: unknown
	readonly options?: readonly Schema[] | readonly unknown[]
}

type MutableRawInputRange = {
	-readonly [TKey in keyof RawInputRange]: RawInputRange[TKey]
}

type PortableShape =
	| {
			readonly kind: 'string'
			readonly format?: string
			readonly range?: RawInputRange
			readonly choices?: readonly string[]
	  }
	| {
			readonly kind: 'number'
			readonly range: RawInputRange
			readonly choices?: readonly number[]
	  }
	| { readonly kind: 'boolean'; readonly choices?: readonly boolean[] }
	| { readonly kind: 'null' }
	| { readonly kind: 'array'; readonly item?: PortableShape; readonly range?: RawInputRange }
	| {
			readonly kind: 'tuple'
			/** Omitted when any positional item cannot be described portably. */
			readonly items?: readonly PortableShape[]
			readonly rest?: PortableShape
			readonly open?: true
	  }
	| { readonly kind: 'object' }
	| { readonly kind: 'record'; readonly value?: PortableShape }
	| { readonly kind: 'union'; readonly options: readonly PortableShape[] }

type ShapeResult =
	| { readonly ok: true; readonly shape: PortableShape }
	| { readonly ok: false; readonly schemaType: string; readonly reason: string }

type PathResult =
	| { readonly ok: true; readonly schemas: readonly Schema[] }
	| {
			readonly ok: false
			readonly kind: 'path_not_found' | 'ambiguous_path'
			readonly schemaType: string
			readonly reason: string
	  }

const TRANSPARENT_WRAPPERS = new Set([
	'optional',
	'exact_optional',
	'undefinedable',
	'non_optional',
])

const PATH_WRAPPERS = new Set([
	...TRANSPARENT_WRAPPERS,
	'nullable',
	'nullish',
	'non_nullable',
	'non_nullish',
])

const OBJECT_TYPES = new Set(['object', 'strict_object', 'loose_object', 'object_with_rest'])
const TUPLE_TYPES = new Set(['tuple', 'strict_tuple', 'loose_tuple', 'tuple_with_rest'])

const PORTABLE_FORMATS: Readonly<Record<string, string>> = {
	base64: 'base64',
	bic: 'BIC',
	cuid2: 'CUID2',
	decimal: 'decimal',
	digits: 'digits',
	email: 'email',
	emoji: 'emoji',
	hex_color: 'hex color',
	hexadecimal: 'hexadecimal',
	imei: 'IMEI',
	ip: 'IP address',
	ipv4: 'IPv4 address',
	ipv6: 'IPv6 address',
	iso_date: 'ISO date',
	iso_date_time: 'ISO date-time',
	iso_date_time_second: 'ISO date-time',
	iso_time: 'ISO time',
	iso_time_second: 'ISO time',
	iso_timestamp: 'ISO timestamp',
	iso_week: 'ISO week',
	mac: 'MAC address',
	nanoid: 'Nano ID',
	octal: 'octal',
	slug: 'slug',
	ulid: 'ULID',
	url: 'URL',
	uuid: 'UUID',
}

function isSchema(value: unknown): value is SchemaRecord {
	return (
		Boolean(value) && typeof value === 'object' && (value as { kind?: string }).kind === 'schema'
	)
}

function pipeRoot(schema: Schema): SchemaRecord {
	let current = schema as SchemaRecord
	const seen = new Set<Schema>()
	while (current.pipe && !seen.has(current)) {
		seen.add(current)
		const first = current.pipe[0]
		if (!isSchema(first) || first === current) break
		current = first
	}
	return current
}

function unwrapForPath(schema: Schema): SchemaRecord {
	let current = pipeRoot(schema)
	const seen = new Set<Schema>()
	while (PATH_WRAPPERS.has(current.type) && current.wrapped && !seen.has(current)) {
		seen.add(current)
		current = pipeRoot(current.wrapped)
	}
	return current
}

function isPathAbsenceOnly(schema: Schema, seen: Set<Schema> = new Set()): boolean {
	if (seen.has(schema)) return false
	const current = pipeRoot(schema)
	const nextSeen = new Set(seen).add(schema)
	if (current.type === 'null' || current.type === 'undefined') return true
	if (current.type === 'literal' && current.literal === null) return true
	if (current.type === 'union') {
		const options = current.options ?? []
		return (
			options.length > 0 &&
			options.every((option) => isSchema(option) && isPathAbsenceOnly(option, nextSeen))
		)
	}
	return false
}

function resolvePath(schema: Schema, path: readonly string[], offset = 0): PathResult {
	if (offset === path.length) return { ok: true, schemas: [schema] }

	const current = unwrapForPath(schema)
	const segment = path[offset]
	if (OBJECT_TYPES.has(current.type)) {
		const direct = current.entries?.[segment]
		if (isSchema(direct)) return resolvePath(direct, path, offset + 1)
		if (current.type === 'object_with_rest' && isSchema(current.rest)) {
			return resolvePath(current.rest, path, offset + 1)
		}
		return {
			ok: false,
			kind: 'path_not_found',
			schemaType: current.type,
			reason: `Raw input path segment ${JSON.stringify(segment)} does not exist on ${current.type}.`,
		}
	}

	if (current.type === 'intersect') {
		const matches = (current.options ?? [])
			.filter(isSchema)
			.map((option) => resolvePath(option, path, offset))
			.filter((result): result is Extract<PathResult, { ok: true }> => result.ok)
		if (matches.length === 1) return matches[0]
		if (matches.length > 1) {
			return {
				ok: false,
				kind: 'ambiguous_path',
				schemaType: current.type,
				reason: `Raw input path segment ${JSON.stringify(segment)} is declared by multiple intersection options.`,
			}
		}
		return {
			ok: false,
			kind: 'path_not_found',
			schemaType: current.type,
			reason: `Raw input path segment ${JSON.stringify(segment)} does not exist on the intersection.`,
		}
	}

	if (current.type === 'union' || current.type === 'variant') {
		const options = (current.options ?? [])
			.filter(isSchema)
			.filter((option) => current.type === 'variant' || !isPathAbsenceOnly(option))
		const results = options.map((option) => resolvePath(option, path, offset))
		if (results.length === 0 || results.some((result) => !result.ok)) {
			return {
				ok: false,
				kind: 'ambiguous_path',
				schemaType: current.type,
				reason: `Raw input path segment ${JSON.stringify(segment)} is not present in every ${current.type} option.`,
			}
		}
		return {
			ok: true,
			schemas: results.flatMap((result) => (result.ok ? result.schemas : [])),
		}
	}

	return {
		ok: false,
		kind: 'path_not_found',
		schemaType: current.type,
		reason: `Raw input path cannot continue through ${current.type}.`,
	}
}

type RawValidationActions = {
	readonly actions: Array<Record<string, unknown>>
	readonly transformed: boolean
}

function collectRawValidationActions(
	schema: Schema,
	bucket: Array<Record<string, unknown>> = [],
	seen: Set<unknown> = new Set(),
): RawValidationActions {
	if (seen.has(schema)) return { actions: bucket, transformed: false }
	seen.add(schema)
	const current = schema as SchemaRecord

	if (current.pipe) {
		const first = current.pipe[0]
		if (isSchema(first)) {
			const nested = collectRawValidationActions(first, bucket, seen)
			if (nested.transformed) return nested
		}
		for (let index = 1; index < current.pipe.length; index++) {
			const item = current.pipe[index]
			if (!item || typeof item !== 'object') continue
			const action = item as Record<string, unknown>
			if (action.kind === 'transformation') {
				return { actions: bucket, transformed: true }
			}
			if (action.kind === 'validation') bucket.push(action)
			else if (isSchema(action)) {
				const nested = collectRawValidationActions(action, bucket, seen)
				if (nested.transformed) return nested
			}
		}
		return { actions: bucket, transformed: false }
	}

	if (current.wrapped && isSchema(current.wrapped)) {
		return collectRawValidationActions(current.wrapped, bucket, seen)
	}
	return { actions: bucket, transformed: false }
}

function finiteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function uniqueChoices<T extends RawInputChoice>(choices: readonly T[]): readonly T[] {
	const unique: T[] = []
	for (const choice of choices) {
		if (!unique.some((other) => Object.is(other, choice))) unique.push(choice)
	}
	return unique
}

function applyStaticFacts(schema: Schema, shape: PortableShape): PortableShape {
	const { actions } = collectRawValidationActions(schema)
	if (shape.kind === 'string') {
		const range: MutableRawInputRange = { ...shape.range }
		let format = shape.format
		for (const action of actions) {
			const type = typeof action.type === 'string' ? action.type : ''
			if (!format && PORTABLE_FORMATS[type]) format = PORTABLE_FORMATS[type]
			if (type === 'length' && finiteNumber(action.requirement)) {
				range.minLength = action.requirement
				range.maxLength = action.requirement
			} else if (type === 'min_length' && finiteNumber(action.requirement)) {
				range.minLength = Math.max(range.minLength ?? 0, action.requirement)
			} else if (type === 'max_length' && finiteNumber(action.requirement)) {
				range.maxLength = Math.min(range.maxLength ?? Number.POSITIVE_INFINITY, action.requirement)
			}
		}
		return {
			...shape,
			...(format ? { format } : {}),
			...(Object.keys(range).length > 0 ? { range } : {}),
		}
	}

	if (shape.kind === 'number') {
		const range: MutableRawInputRange = { finite: true, ...shape.range }
		for (const action of actions) {
			const type = typeof action.type === 'string' ? action.type : ''
			if (type === 'integer') range.integer = true
			else if (type === 'min_value' && finiteNumber(action.requirement)) {
				range.minimum = Math.max(range.minimum ?? Number.NEGATIVE_INFINITY, action.requirement)
			} else if (type === 'max_value' && finiteNumber(action.requirement)) {
				range.maximum = Math.min(range.maximum ?? Number.POSITIVE_INFINITY, action.requirement)
			} else if (type === 'multiple_of' && finiteNumber(action.requirement)) {
				range.multipleOf = action.requirement
			}
		}
		return { ...shape, range }
	}

	if (shape.kind === 'array') {
		const range: MutableRawInputRange = { ...shape.range }
		for (const action of actions) {
			const type = typeof action.type === 'string' ? action.type : ''
			if (type === 'length' && finiteNumber(action.requirement)) {
				range.minLength = action.requirement
				range.maxLength = action.requirement
			} else if (type === 'min_length' && finiteNumber(action.requirement)) {
				range.minLength = Math.max(range.minLength ?? 0, action.requirement)
			} else if (type === 'max_length' && finiteNumber(action.requirement)) {
				range.maxLength = Math.min(range.maxLength ?? Number.POSITIVE_INFINITY, action.requirement)
			}
		}
		return { ...shape, ...(Object.keys(range).length > 0 ? { range } : {}) }
	}

	return shape
}

function withoutNull(shape: PortableShape): PortableShape | undefined {
	if (shape.kind === 'null') return undefined
	if (shape.kind !== 'union') return shape
	const options = shape.options.flatMap((option) => {
		const present = withoutNull(option)
		return present ? [present] : []
	})
	return options.length > 0 ? mergeAlternatives(options) : undefined
}

function unsupported(schema: SchemaRecord, detail?: string): ShapeResult {
	return {
		ok: false,
		schemaType: schema.type,
		reason: detail ?? `Raw input transport cannot be derived from schema type ${schema.type}.`,
	}
}

function analyzeShape(schema: Schema, seen: Set<Schema> = new Set()): ShapeResult {
	if (seen.has(schema))
		return unsupported(schema as SchemaRecord, 'Recursive raw input schemas are unsupported.')
	const nextSeen = new Set(seen).add(schema)
	const current = pipeRoot(schema)

	if (TRANSPARENT_WRAPPERS.has(current.type)) {
		if (!isSchema(current.wrapped)) return unsupported(current)
		const wrapped = analyzeShape(current.wrapped, nextSeen)
		return wrapped.ok ? { ok: true, shape: applyStaticFacts(schema, wrapped.shape) } : wrapped
	}

	if (current.type === 'non_nullable' || current.type === 'non_nullish') {
		if (!isSchema(current.wrapped)) return unsupported(current)
		const wrapped = analyzeShape(current.wrapped, nextSeen)
		if (!wrapped.ok) return wrapped
		const present = withoutNull(wrapped.shape)
		return present
			? { ok: true, shape: applyStaticFacts(schema, present) }
			: unsupported(current, `${current.type} accepts no projectable present raw input.`)
	}

	if (current.type === 'nullable' || current.type === 'nullish') {
		if (!isSchema(current.wrapped)) return unsupported(current)
		const wrapped = analyzeShape(current.wrapped, nextSeen)
		if (!wrapped.ok) return wrapped
		return {
			ok: true,
			shape: { kind: 'union', options: [wrapped.shape, { kind: 'null' }] },
		}
	}

	let shape: PortableShape
	if (current.type === 'string') {
		shape = { kind: 'string' }
	} else if (current.type === 'number') {
		shape = { kind: 'number', range: { finite: true } }
	} else if (current.type === 'boolean') {
		shape = { kind: 'boolean' }
	} else if (current.type === 'null') {
		shape = { kind: 'null' }
	} else if (current.type === 'literal') {
		const literal = current.literal
		if (typeof literal === 'string') shape = { kind: 'string', choices: [literal] }
		else if (finiteNumber(literal))
			shape = { kind: 'number', range: { finite: true }, choices: [literal] }
		else if (typeof literal === 'boolean') shape = { kind: 'boolean', choices: [literal] }
		else if (literal === null) shape = { kind: 'null' }
		else
			return unsupported(
				current,
				'Only JSON-compatible finite Valibot literals have a raw input transport.',
			)
	} else if (current.type === 'picklist' || current.type === 'enum') {
		const options = (current.options ?? []).filter(
			(value): value is RawInputChoice =>
				typeof value === 'string' ||
				typeof value === 'boolean' ||
				value === null ||
				finiteNumber(value),
		)
		if (options.length !== (current.options ?? []).length || options.length === 0) {
			return unsupported(
				current,
				`${current.type} contains a non-JSON-compatible or empty choice set.`,
			)
		}
		const choices = uniqueChoices(options)
		const optionShapes = choices.map((choice): PortableShape => {
			if (typeof choice === 'string') return { kind: 'string', choices: [choice] }
			if (typeof choice === 'number')
				return { kind: 'number', range: { finite: true }, choices: [choice] }
			if (typeof choice === 'boolean') return { kind: 'boolean', choices: [choice] }
			return { kind: 'null' }
		})
		shape = mergeAlternatives(optionShapes)
	} else if (current.type === 'array') {
		const itemResult = isSchema(current.item) ? analyzeShape(current.item, nextSeen) : undefined
		shape = { kind: 'array', ...(itemResult?.ok ? { item: itemResult.shape } : {}) }
	} else if (TUPLE_TYPES.has(current.type)) {
		const rawItems = current.items ?? []
		const items = rawItems.filter(isSchema).map((item) => analyzeShape(item, nextSeen))
		const rest = isSchema(current.rest) ? analyzeShape(current.rest, nextSeen) : undefined
		const hasPortableItems =
			items.length === rawItems.length && items.every((result) => result.ok) && rest?.ok !== false
		shape = {
			kind: 'tuple',
			...(hasPortableItems
				? {
						items: items.flatMap((result) => (result.ok ? [result.shape] : [])),
						...(rest?.ok ? { rest: rest.shape } : {}),
					}
				: {}),
			...(current.type === 'loose_tuple' ? { open: true } : {}),
		}
	} else if (OBJECT_TYPES.has(current.type)) {
		shape = { kind: 'object' }
	} else if (current.type === 'record') {
		const value = isSchema(current.value) ? analyzeShape(current.value, nextSeen) : undefined
		shape = { kind: 'record', ...(value?.ok ? { value: value.shape } : {}) }
	} else if (current.type === 'variant') {
		const options = (current.options ?? [])
			.filter(isSchema)
			.map((option) => analyzeShape(option, nextSeen))
		if (options.length === 0 || options.some((option) => !option.ok)) return unsupported(current)
		const shapes = options.flatMap((option) => (option.ok ? [option.shape] : []))
		if (!shapes.every(expectsPlainObject)) {
			return unsupported(current, 'Variant raw input options must all be plain-object shapes.')
		}
		shape = { kind: 'object' }
	} else if (current.type === 'union') {
		const rawOptions = current.options ?? []
		const presentOptions = rawOptions
			.filter(isSchema)
			.filter((option) => pipeRoot(option).type !== 'undefined')
		const options = presentOptions.map((option) => analyzeShape(option, nextSeen))
		if (options.length === 0 || options.some((option) => !option.ok)) return unsupported(current)
		shape = mergeAlternatives(options.flatMap((option) => (option.ok ? [option.shape] : [])))
	} else if (current.type === 'intersect') {
		const options = (current.options ?? [])
			.filter(isSchema)
			.map((option) => analyzeShape(option, nextSeen))
		if (options.length === 0 || options.some((option) => !option.ok)) return unsupported(current)
		const shapes = options.flatMap((option) => (option.ok ? [option.shape] : []))
		if (shapes.every(expectsPlainObject)) shape = { kind: 'object' }
		else {
			const transports = new Set(shapes.map(deriveTransport))
			if (transports.size !== 1 || transports.has('json')) {
				return unsupported(
					current,
					'Intersection options do not share one scalar raw input transport.',
				)
			}
			shape = mergeAlternatives(shapes)
		}
	} else {
		return unsupported(current)
	}

	return { ok: true, shape: applyStaticFacts(schema, shape) }
}

function sameShapeFact<T>(values: readonly (T | undefined)[]): T | undefined {
	const first = values[0]
	if (
		first === undefined ||
		values.some((value) => JSON.stringify(value) !== JSON.stringify(first))
	) {
		return undefined
	}
	return first
}

function sameRange(values: readonly (RawInputRange | undefined)[]): RawInputRange | undefined {
	const first = values[0]
	if (
		first === undefined ||
		values.some(
			(value) =>
				value === undefined ||
				value.finite !== first.finite ||
				value.integer !== first.integer ||
				value.minimum !== first.minimum ||
				value.maximum !== first.maximum ||
				value.multipleOf !== first.multipleOf ||
				value.minLength !== first.minLength ||
				value.maxLength !== first.maxLength,
		)
	) {
		return undefined
	}
	return first
}

function summarizeChoices(shape: PortableShape): readonly RawInputChoice[] | undefined {
	if (shape.kind === 'null') return [null]
	if (shape.kind === 'string' || shape.kind === 'number' || shape.kind === 'boolean') {
		return shape.choices
	}
	if (shape.kind !== 'union') return undefined
	const optionChoices = shape.options.map(summarizeChoices)
	if (optionChoices.some((choices) => choices === undefined)) return undefined
	return uniqueChoices(optionChoices.flatMap((choices) => choices ?? []))
}

function summarizeFormat(shape: PortableShape): string | undefined {
	if (shape.kind === 'string') return shape.format
	if (shape.kind !== 'union') return undefined
	return sameShapeFact(shape.options.map(summarizeFormat))
}

function summarizeRange(shape: PortableShape): RawInputRange | undefined {
	if (shape.kind === 'string' || shape.kind === 'number' || shape.kind === 'array')
		return shape.range
	if (shape.kind !== 'union') return undefined
	return sameRange(shape.options.map(summarizeRange))
}

function mergeAlternatives(options: readonly PortableShape[]): PortableShape {
	if (options.length === 1) return options[0]
	const kinds = new Set(options.map((option) => option.kind))
	if (kinds.size === 1 && (kinds.has('string') || kinds.has('number') || kinds.has('boolean'))) {
		const choices = options.map(summarizeChoices)
		const mergedChoices = choices.every((choice) => choice !== undefined)
			? uniqueChoices(choices.flatMap((choice) => choice ?? []))
			: undefined
		if (kinds.has('string')) {
			const format = sameShapeFact(options.map(summarizeFormat))
			const range = sameRange(options.map(summarizeRange))
			return {
				kind: 'string',
				...(mergedChoices ? { choices: mergedChoices as readonly string[] } : {}),
				...(format ? { format } : {}),
				...(range ? { range } : {}),
			}
		}
		if (kinds.has('number')) {
			return {
				kind: 'number',
				range: sameRange(options.map(summarizeRange)) ?? { finite: true },
				...(mergedChoices ? { choices: mergedChoices as readonly number[] } : {}),
			}
		}
		return {
			kind: 'boolean',
			...(mergedChoices ? { choices: mergedChoices as readonly boolean[] } : {}),
		}
	}
	return { kind: 'union', options }
}

function deriveTransport(shape: PortableShape): RawInputTransport {
	if (shape.kind === 'string' || shape.kind === 'number' || shape.kind === 'boolean')
		return shape.kind
	if (shape.kind !== 'union') return 'json'
	const transports = new Set(shape.options.map(deriveTransport))
	return transports.size === 1 && !transports.has('json')
		? (transports.values().next().value as RawInputTransport)
		: 'json'
}

function expectsPlainObject(shape: PortableShape): boolean {
	if (shape.kind === 'object' || shape.kind === 'record') return true
	return (
		shape.kind === 'union' && shape.options.length > 0 && shape.options.every(expectsPlainObject)
	)
}

function quoteChoice(choice: RawInputChoice): string {
	return typeof choice === 'string' ? JSON.stringify(choice) : String(choice)
}

function describeRange(
	range: RawInputRange | undefined,
	kind: 'string' | 'number' | 'array',
): string[] {
	if (!range) return []
	const facts: string[] = []
	if (kind === 'number') {
		if (range.finite && range.integer) facts.push('finite integer')
		else if (range.finite) facts.push('finite')
		else if (range.integer) facts.push('integer')
		if (range.minimum !== undefined) facts.push(`>= ${range.minimum}`)
		if (range.maximum !== undefined) facts.push(`<= ${range.maximum}`)
		if (range.multipleOf !== undefined) facts.push(`multiple of ${range.multipleOf}`)
	} else {
		if (range.minLength !== undefined) facts.push(`length >= ${range.minLength}`)
		if (range.maxLength !== undefined) facts.push(`length <= ${range.maxLength}`)
	}
	return facts
}

function describeShape(shape: PortableShape): string {
	if (shape.kind === 'string') {
		const facts = [shape.format, ...describeRange(shape.range, 'string')].filter(
			Boolean,
		) as string[]
		if (shape.choices) facts.push(`one of ${shape.choices.map(quoteChoice).join(', ')}`)
		return facts.length > 0 ? `string (${facts.join(', ')})` : 'string'
	}
	if (shape.kind === 'number') {
		const facts = describeRange(shape.range, 'number')
		if (shape.choices) facts.push(`one of ${shape.choices.map(quoteChoice).join(', ')}`)
		return facts.length > 0 ? `number (${facts.join(', ')})` : 'number'
	}
	if (shape.kind === 'boolean') {
		return `boolean (${(shape.choices ?? [true, false]).map(quoteChoice).join(' or ')})`
	}
	if (shape.kind === 'null') return 'null'
	if (shape.kind === 'array') {
		const item = shape.item ? `<${describeShape(shape.item)}>` : ''
		const facts = describeRange(shape.range, 'array')
		return `array${item}${facts.length > 0 ? ` (${facts.join(', ')})` : ''}`
	}
	if (shape.kind === 'tuple') {
		if (!shape.items) return 'array'
		const items = shape.items.map(describeShape)
		if (shape.rest) items.push(`...${describeShape(shape.rest)}[]`)
		else if (shape.open) items.push('...unknown[]')
		return `[${items.join(', ')}]`
	}
	if (shape.kind === 'object') return 'object'
	if (shape.kind === 'record') {
		return shape.value ? `object<string, ${describeShape(shape.value)}>` : 'object'
	}
	return `(${shape.options.map(describeShape).join(' or ')})`
}

function describeTarget(schema: Schema, path: readonly string[]): string {
	const metadata = readStandardSchemaMetadata(schema)
	return metadata.description ?? metadata.title ?? (path.length > 0 ? path.join('.') : 'root')
}

function freezeProjection(projection: RawInputProjection): RawInputProjection {
	if (projection.range) Object.freeze(projection.range)
	if (projection.choices) Object.freeze(projection.choices)
	Object.freeze(projection.descriptions)
	Object.freeze(projection.path)
	return Object.freeze(projection)
}

/**
 * Projects one Valibot raw-input target without parsing or executing the schema.
 *
 * `path` addresses object input fields and defaults to the schema root. Pipes are
 * read from their first schema, so transforms never change the derived transport.
 * Optional/default wrappers are inspected structurally; their default getters,
 * validation callbacks, transform operations, and lazy schema getters are never
 * called. Unsupported or non-unique shapes return a stable failure result.
 */
export function projectRawInput(
	schema: Schema,
	path: readonly string[] = [],
): RawInputProjectionResult {
	const snapshotPath = [...path]
	if (!isSchema(schema)) {
		return Object.freeze({
			ok: false,
			kind: 'unsupported_schema',
			path: Object.freeze(snapshotPath),
			reason: 'Raw input projection requires a Valibot schema object.',
			schemaType: 'invalid',
		})
	}

	const target = resolvePath(schema, snapshotPath)
	if (target.ok === false) {
		return Object.freeze({
			ok: false,
			kind: target.kind,
			path: Object.freeze(snapshotPath),
			reason: target.reason,
			schemaType: target.schemaType,
		})
	}

	const analyzed = target.schemas.map((targetSchema) => ({
		schema: targetSchema,
		result: analyzeShape(targetSchema),
	}))
	const failed = analyzed.find(
		(entry): entry is { schema: Schema; result: Extract<ShapeResult, { ok: false }> } =>
			!entry.result.ok,
	)
	if (failed) {
		return Object.freeze({
			ok: false,
			kind: 'unsupported_schema',
			path: Object.freeze(snapshotPath),
			reason: failed.result.reason,
			schemaType: failed.result.schemaType,
		})
	}

	const shape = mergeAlternatives(
		analyzed.flatMap((entry) => (entry.result.ok ? [entry.result.shape] : [])),
	)
	const transport = deriveTransport(shape)
	const format = summarizeFormat(shape)
	const range = summarizeRange(shape)
	const choices = summarizeChoices(shape)
	const inputDescription = `${transport === 'json' ? 'JSON ' : ''}${describeShape(shape)}`
	const descriptions = Array.from(
		new Set(analyzed.map((entry) => describeTarget(entry.schema, snapshotPath))),
	).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

	return freezeProjection({
		ok: true,
		path: snapshotPath,
		transport,
		inputKind: shape.kind,
		inputDescription,
		descriptions,
		...(format ? { format } : {}),
		...(range ? { range: { ...range } } : {}),
		...(choices ? { choices: [...choices] } : {}),
		expectsPlainObject: expectsPlainObject(shape),
	})
}

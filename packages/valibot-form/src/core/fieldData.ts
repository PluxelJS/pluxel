import type { FieldNode } from './fields'
import type { ArrayMeta, MetaType, MetaValueMap } from './meta'

export type FieldData =
	| null
	| boolean
	| number
	| string
	| readonly FieldData[]
	| { readonly [key: string]: FieldData }

type Check = (input: unknown, path: string) => void
type Options = Readonly<Record<string, Check>>

function fail(path: string, message: string): never {
	throw new TypeError(`${path} ${message}`)
}

function propertyPath(path: string, key: string): string {
	return /^[\w$]+$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
}

/** Read descriptors before copying so accessors are never invoked. */
function dataEntries(input: object, path: string, array: boolean): [string, unknown][] {
	const prototype = Object.getPrototypeOf(input)
	if (
		array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
	) {
		fail(path, `must be a plain ${array ? 'array' : 'object'}`)
	}
	const entries: [string, unknown][] = []
	for (const key of Reflect.ownKeys(input)) {
		if (typeof key !== 'string') fail(path, 'must not contain symbol keys')
		if (array && key === 'length') continue
		const at = array && /^(0|[1-9]\d*)$/.test(key) ? `${path}[${key}]` : propertyPath(path, key)
		const descriptor = Object.getOwnPropertyDescriptor(input, key)
		if (!descriptor || !('value' in descriptor)) fail(at, 'must be a data property')
		if (!descriptor.enumerable) fail(at, 'must be enumerable')
		entries.push([key, descriptor.value])
	}
	return entries
}

function copyData(
	input: unknown,
	path: string,
	omitUndefined = false,
	ancestors = new Set<object>(),
): FieldData {
	if (input === null) return null
	if (typeof input === 'string' || typeof input === 'boolean') return input
	if (typeof input === 'number' && Number.isFinite(input)) return input
	if (typeof input !== 'object') fail(path, 'is not portable data')
	if (ancestors.has(input)) fail(path, 'contains a cycle')
	// Bounds recursion for direct callers. Integrations enforce their own message budgets.
	if (ancestors.size >= 128) fail(path, 'exceeds maximum nesting depth')
	ancestors.add(input)
	try {
		const array = Array.isArray(input)
		const entries = dataEntries(input, path, array)
		if (array) {
			if (
				entries.length !== input.length ||
				entries.some(([key], index) => key !== String(index))
			) {
				fail(path, 'must be a dense array without extra fields')
			}
			return Object.freeze(
				entries.map(([key, value]) => copyData(value, `${path}[${key}]`, omitUndefined, ancestors)),
			)
		}
		return Object.freeze(
			Object.fromEntries(
				entries
					.filter(([, value]) => !omitUndefined || value !== undefined)
					.map(([key, value]) => {
						return [key, copyData(value, propertyPath(path, key), omitUndefined, ancestors)]
					}),
			),
		)
	} finally {
		ancestors.delete(input)
	}
}

function record(input: unknown, path: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) fail(path, 'must be an object')
	return input as Record<string, unknown>
}

function options(input: unknown, path: string, checks: Options, required: Options = {}) {
	const data = record(input, path)
	for (const [key, value] of Object.entries(data)) {
		if (Object.hasOwn(required, key)) continue
		if (!Object.hasOwn(checks, key)) fail(propertyPath(path, key), 'is an unsupported field')
		checks[key](value, propertyPath(path, key))
	}
	for (const [key, check] of Object.entries(required)) {
		check(Object.hasOwn(data, key) ? data[key] : undefined, propertyPath(path, key))
	}
}

function shape(checks: Options, required?: Options): Check {
	return (input, path) => options(input, path, checks, required)
}

function each(check: Check): Check {
	return (input, path) => {
		if (!Array.isArray(input)) fail(path, 'must be an array')
		input.forEach((value, index) => check(value, `${path}[${index}]`))
	}
}

function oneOf(...values: readonly (string | number)[]): Check {
	return (input, path) => {
		if (!values.includes(input as string | number))
			fail(path, `must be one of ${values.join(', ')}`)
	}
}

const string: Check = (input, path) => {
	if (typeof input !== 'string') fail(path, 'must be a string')
}
const boolean: Check = (input, path) => {
	if (typeof input !== 'boolean') fail(path, 'must be a boolean')
}
const number: Check = (input, path) => {
	if (typeof input !== 'number' || !Number.isFinite(input)) fail(path, 'must be a finite number')
}
const stringOrNumber: Check = (input, path) => {
	if (typeof input !== 'string') number(input, path)
}
const stringRecord: Check = (input, path) => {
	for (const [key, value] of Object.entries(record(input, path))) {
		string(value, propertyPath(path, key))
	}
}
const badge: Check = (input, path) => {
	if (typeof input !== 'string') options(input, path, { color: string }, { label: string })
}
const sectionOptions = {
	id: string,
	title: string,
	description: string,
	order: number,
	columns: number,
}
const section: Check = (input, path) => {
	if (typeof input !== 'string') options(input, path, sectionOptions)
}
const column = shape({ label: string, placeholder: string, width: stringOrNumber })
const portableValue: Check = () => {} // copyData has already validated its structure

const formOptions = {
	help: string,
	hint: string,
	badge,
	layout: shape({ full: boolean, span: number, align: oneOf('start', 'center', 'end') }),
	hideLabel: boolean,
	hideRequired: boolean,
	disabled: boolean,
	readOnly: boolean,
	hidden: boolean,
} satisfies Partial<Record<keyof MetaValueMap['form'], Check>>
const formMeta = shape(
	{
		...formOptions,
		description: string,
		section: shape(sectionOptions, { id: string }),
	},
	{ label: string },
)

const numberFormatOptions = shape({
	localeMatcher: oneOf('lookup', 'best fit'),
	numberingSystem: string,
	style: oneOf('decimal', 'percent', 'currency', 'unit'),
	currency: string,
	currencyDisplay: oneOf('code', 'symbol', 'narrowSymbol', 'name'),
	currencySign: oneOf('standard', 'accounting'),
	unit: string,
	unitDisplay: oneOf('short', 'long', 'narrow'),
	notation: oneOf('standard', 'scientific', 'engineering', 'compact'),
	compactDisplay: oneOf('short', 'long'),
	signDisplay: oneOf('auto', 'never', 'always', 'exceptZero', 'negative'),
	useGrouping(input, path) {
		if (typeof input !== 'boolean') oneOf('auto', 'always', 'min2', 'true', 'false')(input, path)
	},
	minimumIntegerDigits: number,
	minimumFractionDigits: number,
	maximumFractionDigits: number,
	minimumSignificantDigits: number,
	maximumSignificantDigits: number,
	roundingPriority: oneOf('auto', 'morePrecision', 'lessPrecision'),
	roundingIncrement: oneOf(1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000),
	roundingMode: oneOf(
		'ceil',
		'floor',
		'expand',
		'trunc',
		'halfCeil',
		'halfFloor',
		'halfExpand',
		'halfTrunc',
		'halfEven',
	),
	trailingZeroDisplay: oneOf('auto', 'stripIfInteger'),
} satisfies Record<keyof Intl.NumberFormatOptions, Check>)
const numberFormat: Check = (input, path) => {
	numberFormatOptions(input, path)
	try {
		Intl.NumberFormat(undefined, input as Intl.NumberFormatOptions)
	} catch {
		fail(path, 'must contain valid Intl.NumberFormat options')
	}
}

const picklistEntry = shape(
	{ label: string, description: string, group: string, disabled: boolean, accentColor: string },
	{ value: stringOrNumber },
)
const collectionControls = {
	addable: boolean,
	removable: boolean,
	reorderable: boolean,
	addLabel: string,
	emptyHint: string,
}
const arrayOptions = {
	...collectionControls,
	layout: oneOf('list', 'grid', 'picker'),
	columns: number,
	disableAutoGrid: boolean,
	itemLabel: string,
}
const recordOptions = {
	...collectionControls,
	layout: oneOf('table', 'list'),
	editableKey: boolean,
	key: column,
}
const metadata = {
	form: { ...formOptions, title: string, description: string, section },
	string: {
		control: oneOf('text', 'textarea', 'password', 'code'),
		placeholder: string,
		rows: number,
	},
	number: { placeholder: string, step: number, format: numberFormat },
	picklist: {
		control: oneOf('select', 'segmented', 'radio'),
		entries: each(picklistEntry),
		labels: stringRecord,
		disabled: each(stringOrNumber),
		placeholder: string,
		searchable: boolean,
		clearable: boolean,
		max: number,
		create: boolean,
		emptyLabel: string,
	},
	array: { ...arrayOptions, defaultItem: portableValue },
	record: { ...recordOptions, value: column },
	object: {
		variant: oneOf('card', 'stack'),
		columns: number,
		gap: stringOrNumber,
		collapsible: boolean,
		collapsed: boolean,
	},
	union: {
		control: oneOf('select', 'segmented', 'radio', 'switch'),
		labels: stringRecord,
		descriptions: stringRecord,
		placeholder: string,
		searchable: boolean,
		expose: oneOf('auto', 'always', 'never'),
		preserve: boolean,
		compact: boolean,
		discriminator: string,
	},
} satisfies { [K in MetaType]: Record<keyof MetaValueMap[K], Check> }

export function readFieldMetadata<K extends Exclude<MetaType, 'array'>>(
	type: K,
	input: MetaValueMap[K] | undefined,
	path: string,
): MetaValueMap[K] {
	const label = `${path || 'field'}.${type}Meta`
	const data = copyData(input === undefined ? {} : input, label, true)
	options(data, label, metadata[type])
	return data as MetaValueMap[K]
}

export function readArrayMetadata(
	input: ArrayMeta | undefined,
	path: string,
): { options: Omit<ArrayMeta, 'defaultItem'> & { defaultItem?: FieldData }; reason?: string } {
	const label = `${path || 'field'}.arrayMeta`
	if (input === undefined) return { options: {} }
	const result = Object.fromEntries(dataEntries(record(input, label), label, false))
	const { defaultItem, ...rawOptions } = result
	const data = copyData(rawOptions, label, true)
	options(data, label, arrayOptions)
	const parsed = data as Omit<ArrayMeta, 'defaultItem'>
	if (defaultItem === undefined) return { options: parsed }
	try {
		return { options: { ...parsed, defaultItem: copyData(defaultItem, `${label}.defaultItem`) } }
	} catch (error) {
		if (!(error instanceof TypeError)) throw error
		return { options: parsed, reason: error.message }
	}
}

const baseOptions = { name: string }
const baseRequired = {
	kind: string,
	path: string,
	depth: number,
	meta: formMeta,
	required: boolean,
	nullable: boolean,
}

function readNode(input: unknown, path: string, depth: number): void {
	if (depth > 32) fail(path, 'exceeds maximum nesting depth')
	const node = record(input, path)
	if (node.depth !== depth) fail(`${path}.depth`, `must equal its traversal depth (${depth})`)
	const child: Check = (value, at) => readNode(value, at, depth + 1)
	const nullableChild: Check = (value, at) => {
		if (value !== null) child(value, at)
	}
	let optional: Options
	let required: Options = baseRequired
	switch (node.kind) {
		case 'string':
			optional = {
				...metadata.string,
				literal: string,
				minLength: number,
				maxLength: number,
				format: string,
			}
			required = { ...baseRequired, control: metadata.string.control }
			break
		case 'number':
			optional = { ...metadata.number, literal: number, min: number, max: number, integer: boolean }
			break
		case 'boolean':
			optional = { literal: boolean }
			required = { ...baseRequired, control: oneOf('switch') }
			break
		case 'picklist':
			optional = { ...metadata.picklist, options: each(stringOrNumber) }
			required = { ...baseRequired, control: metadata.picklist.control }
			break
		case 'array':
			optional = { ...metadata.array, item: nullableChild, min: number, max: number }
			break
		case 'record':
			optional = {
				...recordOptions,
				value: nullableChild,
				valueMeta: column,
				min: number,
				max: number,
			}
			break
		case 'object':
			optional = metadata.object
			required = { ...baseRequired, fields: each(child) }
			break
		case 'union': {
			const branchField = shape({ replaceValue: boolean }, { key: string, node: child })
			const discriminatorValue: Check = (value, at) => {
				if (value !== null && typeof value !== 'boolean') stringOrNumber(value, at)
			}
			optional = { ...metadata.union, discriminatorField: branchField }
			required = {
				...baseRequired,
				control: metadata.union.control,
				branches: each(shape({ discriminatorValue }, { key: string, fields: each(branchField) })),
				sharedFields: each(branchField),
			}
			break
		}
		case 'unsupported':
			optional = {}
			required = { ...baseRequired, readOnly: boolean, reason: string }
			if (node.readOnly !== true || record(node.meta, `${path}.meta`).readOnly !== true) {
				fail(path, 'must be read-only when kind is unsupported')
			}
			break
		default:
			fail(`${path}.kind`, 'is unsupported')
	}
	options(node, path, { ...baseOptions, ...optional }, required)
	if (node.literal !== undefined && record(node.meta, `${path}.meta`).readOnly !== true) {
		fail(`${path}.meta.readOnly`, 'must be true for a literal field')
	}
}

/** Validate and independently own a portable field tree. */
export function parseFormFields(input: unknown): readonly FieldNode[] {
	const path = 'fields'
	const fields = copyData(input, path)
	each((value, at) => readNode(value, at, 0))(fields, path)
	return fields as unknown as readonly FieldNode[]
}

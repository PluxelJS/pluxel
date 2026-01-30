import type { Schema } from './schema'

export type BadgeMeta = string | { label: string; color?: string }

export type FieldLayout = {
	full?: boolean
	span?: number
	align?: 'start' | 'center' | 'end'
}

export type SectionMeta =
	| string
	| {
			id?: string
			title?: string
			description?: string
			order?: number
			columns?: number
	  }

export interface FormMeta {
	label?: string
	description?: string
	help?: string
	hint?: string
	badge?: BadgeMeta
	section?: SectionMeta
	layout?: FieldLayout
	hideLabel?: boolean
	hideRequired?: boolean
	disabled?: boolean
	readOnly?: boolean
	hidden?: boolean
	required?: boolean
}

export interface StringMeta {
	control?: 'text' | 'textarea' | 'password' | 'code'
	placeholder?: string
	rows?: number
	minLength?: number
	maxLength?: number
	format?: string
}

export interface NumberMeta {
	placeholder?: string
	min?: number
	max?: number
	step?: number
	integer?: boolean
	format?: Intl.NumberFormatOptions
}

export interface BooleanMeta {
	control?: 'switch'
}

export interface PicklistMeta {
	options?: readonly (string | number)[]
	entries?: readonly {
		value: string | number
		label?: string
		description?: string
		group?: string
		disabled?: boolean
		accentColor?: string
	}[]
	labels?: Partial<Record<string | number, string>>
	disabled?: readonly (string | number)[]
	placeholder?: string
	searchable?: boolean
	clearable?: boolean
	max?: number
	create?: boolean
	control?: 'select' | 'segmented' | 'radio'
	emptyLabel?: string
}

export interface ArrayMeta {
	layout?: 'list' | 'grid' | 'picker'
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

export interface RecordMeta {
	layout?: 'table' | 'list'
	min?: number
	max?: number
	addable?: boolean
	removable?: boolean
	reorderable?: boolean
	editableKey?: boolean
	key?: {
		label?: string
		placeholder?: string
		width?: number | string
	}
	value?: {
		label?: string
		placeholder?: string
		width?: number | string
	}
	addLabel?: string
	emptyHint?: string
}

export interface ObjectMeta {
	variant?: 'card' | 'stack'
	columns?: number
	gap?: number | string
	collapsible?: boolean
	collapsed?: boolean
}

export interface UnionMeta {
	control?: 'select' | 'segmented' | 'radio' | 'switch'
	labels?: Record<string, string>
	descriptions?: Record<string, string>
	placeholder?: string
	searchable?: boolean
	expose?: 'auto' | 'always' | 'never'
	preserve?: boolean
	compact?: boolean
	discriminator?: string
}

export const META_TYPES = {
	FORM: 'form',
	STRING: 'string',
	NUMBER: 'number',
	BOOLEAN: 'boolean',
	PICKLIST: 'picklist',
	ARRAY: 'array',
	RECORD: 'record',
	OBJECT: 'object',
	UNION: 'union',
} as const

export type MetaType = (typeof META_TYPES)[keyof typeof META_TYPES]

export interface MetaValueMap {
	form: FormMeta
	string: StringMeta
	number: NumberMeta
	boolean: BooleanMeta
	picklist: PicklistMeta
	array: ArrayMeta
	record: RecordMeta
	object: ObjectMeta
	union: UnionMeta
}

export type MetadataAction<TType extends MetaType, TInput = unknown> = {
	kind: 'metadata'
	type: TType
	metadata: MetaValueMap[TType]
	reference: (metadata: MetaValueMap[TType]) => MetadataAction<TType, TInput>
}

export function createMetaFactory<TType extends MetaType, TInput = unknown>(type: TType) {
	const factory = (metadata: MetaValueMap[TType]): MetadataAction<TType, TInput> => ({
		kind: 'metadata',
		type,
		metadata,
		reference: factory,
	})
	return factory
}

export const formMeta = createMetaFactory<'form'>('form')
export const stringMeta = createMetaFactory<'string', string>('string')
export const numberMeta = createMetaFactory<'number', number>('number')
export const booleanMeta = createMetaFactory<'boolean', boolean>('boolean')
export const picklistMeta = createMetaFactory<'picklist', string | number>('picklist')
export const arrayMeta = createMetaFactory<'array', unknown[]>('array')
export const recordMeta = createMetaFactory<'record', Record<string, unknown>>('record')
export const objectMeta = createMetaFactory<'object', object>('object')
export const unionMeta = createMetaFactory<'union', unknown>('union')

export const f = {
	formMeta,
	stringMeta,
	numberMeta,
	booleanMeta,
	picklistMeta,
	arrayMeta,
	recordMeta,
	objectMeta,
	unionMeta,
}

export type SchemaInput = Schema

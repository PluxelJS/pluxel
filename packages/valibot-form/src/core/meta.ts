import { metadata, type BaseMetadata, type MetadataAction as ValibotMetadataAction } from 'valibot'
import type { Schema } from './schema'
import { FORM_METADATA_KEY } from './schemaMetadata'

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
	title?: string
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
}

export interface StringMeta {
	control?: 'text' | 'textarea' | 'password' | 'code'
	placeholder?: string
	rows?: number
}

export interface NumberMeta {
	placeholder?: string
	step?: number
	format?: Intl.NumberFormatOptions
}

export interface PicklistMeta {
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
	PICKLIST: 'picklist',
	ARRAY: 'array',
	RECORD: 'record',
	OBJECT: 'object',
	UNION: 'union',
} as const

export type MetaType = (typeof META_TYPES)[keyof typeof META_TYPES]
type TypedMetaType = Exclude<MetaType, typeof META_TYPES.FORM>

export interface MetaValueMap {
	form: FormMeta
	string: StringMeta
	number: NumberMeta
	picklist: PicklistMeta
	array: ArrayMeta
	record: RecordMeta
	object: ObjectMeta
	union: UnionMeta
}

/**
 * A lightweight metadata action carried inside `v.pipe(...)`.
 *
 * Valibot v1.2 tightened type constraints around `pipe()` items, requiring metadata
 * actions to expose `~types.issue = never` (via `BaseMetadata`) so they don't pollute
 * schema issue inference.
 *
 * Runtime-wise this is still a plain object; Valibot does not execute metadata items.
 */
export type MetadataAction<TType extends TypedMetaType, TInput = unknown> = Omit<
	BaseMetadata<TInput>,
	'type' | 'reference'
> & {
	readonly type: TType
	readonly metadata: MetaValueMap[TType]
	readonly reference: (...args: any[]) => MetadataAction<TType, TInput>
}

export function createMetaFactory<TType extends TypedMetaType>(type: TType) {
	// Use a variadic signature to stay assignable to Valibot's `BaseMetadata["reference"]`,
	// which is typed as `(...args: any[]) => BaseMetadata<any>`.
	const factory = <TInput = any>(
		...args: [metadata: MetaValueMap[TType]]
	): MetadataAction<TType, TInput> => ({
		kind: 'metadata',
		type,
		metadata: args[0],
		reference: factory as unknown as (...args: any[]) => MetadataAction<TType, TInput>,
	})
	return factory
}

type FormMetadataAction<TInput> = ValibotMetadataAction<
	TInput,
	Readonly<{
		title?: string
		description?: string
		[FORM_METADATA_KEY]: Omit<FormMeta, 'title' | 'description'>
	}>
>

/**
 * Groups field text and presentation preferences in one action while storing title and
 * description in Valibot's standard metadata channel.
 */
export function formMeta<TInput = any>(value: FormMeta): FormMetadataAction<TInput> {
	const { title, description, ...presentation } = value
	return metadata({
		...(title !== undefined ? { title } : {}),
		...(description !== undefined ? { description } : {}),
		[FORM_METADATA_KEY]: presentation,
	}) as FormMetadataAction<TInput>
}

export const stringMeta = createMetaFactory<'string'>('string') as <TInput extends string = string>(
	metadata: StringMeta,
) => MetadataAction<'string', TInput>
export const numberMeta = createMetaFactory<'number'>('number') as <TInput extends number = number>(
	metadata: NumberMeta,
) => MetadataAction<'number', TInput>
export const picklistMeta = createMetaFactory<'picklist'>('picklist') as <
	TInput extends string | number = string | number,
>(
	metadata: PicklistMeta,
) => MetadataAction<'picklist', TInput>
export const arrayMeta = createMetaFactory<'array'>('array') as <
	TInput extends unknown[] = unknown[],
>(
	metadata: ArrayMeta,
) => MetadataAction<'array', TInput>
export const recordMeta = createMetaFactory<'record'>('record') as <
	TInput extends Record<string, unknown> = Record<string, unknown>,
>(
	metadata: RecordMeta,
) => MetadataAction<'record', TInput>
export const objectMeta = createMetaFactory<'object'>('object') as <TInput extends object = object>(
	metadata: ObjectMeta,
) => MetadataAction<'object', TInput>
export const unionMeta = createMetaFactory<'union'>('union')

export const f = {
	formMeta,
	stringMeta,
	numberMeta,
	picklistMeta,
	arrayMeta,
	recordMeta,
	objectMeta,
	unionMeta,
}

export type SchemaInput = Schema

import type {
	ArrayMetaOptions,
	BooleanMetaOptions,
	NumberMetaOptions,
	PicklistMetaOptions,
	RecordMetaOptions,
	StringMetaOptions,
} from '../actions'
import type { FormMeta } from '../actions/formMeta'
import type { ObjectMetaOptions } from '../actions/objectMeta'
import type { UnionMetaOptions } from '../actions/union'

export const META_MAP = {
	FORM: 'form',
	STRING: 'string',
	NUMBER: 'number',
	BOOLEAN: 'boolean',
	PICKLIST: 'picklist',
	ARRAY: 'array',
	RECORD: 'record',
	object: 'object',
	union: 'union',
} as const

export type MetaType = (typeof META_MAP)[keyof typeof META_MAP]
export type CheckMetaType<T extends MetaType> = T
export type ExtractableMetaType = Exclude<MetaType, 'form'>

// 3. 同样的「值→返回类型」映射接口
export interface MetaReturnMap {
	form: FormMeta
	string: StringMetaOptions
	number: NumberMetaOptions
	boolean: BooleanMetaOptions
	picklist: PicklistMetaOptions
	array: ArrayMetaOptions
	record: RecordMetaOptions
	object: ObjectMetaOptions
	union: UnionMetaOptions
}

export type MetaTypeReturn<T extends MetaType> = MetaReturnMap[T]

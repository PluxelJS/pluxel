import type {
	BooleanMetaOptions,
	NumberMetaOptions,
	PicklistMetaOptions,
	StringMetaOptions,
} from '../actions'
import type { FormMeta } from '../actions/formMeta'
import type { ObjectMetaOptions } from '../actions/objectMeta'

export const META_MAP = {
	FORM: 'form',
	STRING: 'string',
	NUMBER: 'number',
	BOOLEAN: 'boolean',
	PICKLIST: 'picklist',
	object: 'object',
} as const

export type MetaType = (typeof META_MAP)[keyof typeof META_MAP]
export type CheckMetaType<T extends MetaType> = T

// 3. 同样的「值→返回类型」映射接口
export interface MetaReturnMap {
	form: FormMeta
	string: StringMetaOptions
	number: NumberMetaOptions
	boolean: BooleanMetaOptions
	picklist: PicklistMetaOptions
	object: ObjectMetaOptions
}

export type MetaTypeReturn<T extends MetaType> = MetaReturnMap[T]

import type {
	BooleanMetaOptions,
	NumberMetaOptions,
	PicklistMetaOptions,
	StringMetaOptions,
} from '../actions'
import type { FormMeta } from '../actions/formMeta'
import type { ObjectMetaOptions } from '../actions/objectMeta'

// 1. 一处定义：运行时常量（会被编译成字面量），同时也是类型
export enum MetaType {
	FORM = 'form',
	STRING = 'string',
	NUMBER = 'number',
	BOOLEAN = 'boolean',
	PICKLIST = 'picklist',
	OBJECT = 'object',
}

// 2. 命名空间承载所有「动作→返回类型」的映射
export namespace MetaType {
	// 2.1 构造一个 interface，Key 必须和上面 MetaType 的 value 一致
	export interface ReturnMap {
		[MetaType.FORM]: FormMeta
		[MetaType.STRING]: StringMetaOptions
		[MetaType.NUMBER]: NumberMetaOptions
		[MetaType.BOOLEAN]: BooleanMetaOptions
		[MetaType.PICKLIST]: PicklistMetaOptions
		[MetaType.OBJECT]: ObjectMetaOptions
	}

	// 2.2 拿到所有合法的名字
	export type Name = keyof ReturnMap // "form" | "string" | "number"

	// 2.3 任意 Name 对应的返回类型
	export type Return<T extends Name> = ReturnMap[T]
}

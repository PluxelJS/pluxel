import {
	extractArrayProps,
	extractBooleanProps,
	extractNumberProps,
	extractPicklistProps,
	extractRecordProps,
	extractStringProps,
} from '../actions'
import type { MetaType } from './MetaType'

export function buildRendererMap<
	T extends Partial<{ [K in MetaType]: (schema: any) => any }>,
>(extractors: T & Record<Exclude<keyof T, MetaType>, never>) {
	const result: { [K in keyof T]: { type: K; extract: T[K] } } = {} as any
	for (const key of Object.keys(extractors) as Array<keyof T>) {
		result[key] = {
			type: key, // K 本身就已经被约束为 MetaType
			extract: extractors[key]!,
		}
	}
	return result
}

// 用法：
// TypeScript 会检查：
// - 只能传 MetaType 里的键（string/number/...）
// - 对应的 extract 函数签名，其参数类型必须正好是 MetaReturnMap[该键]
export const extractMap = buildRendererMap({
	string: extractStringProps,
	number: extractNumberProps,
	boolean: extractBooleanProps,
	picklist: extractPicklistProps,
	array: extractArrayProps,
	record: extractRecordProps,
})

export type ExtractMap = typeof extractMap

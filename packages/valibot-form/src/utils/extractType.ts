import {
	extractBooleanProps,
	extractNumberProps,
	extractPicklistProps,
	extractStringProps,
} from '../actions'
import type { MetaType } from './MetaType'

// ❶ 定义一个帮助函数：
//   - 限制 T 的 key 必须是 MetaType 的子集
//   - 结果 result[k].type 自动推断为字面量 k
//   - extract 字段类型自动对应 T[k]
function buildRendererMap<
	T extends Partial<Record<MetaType, (schema: any) => any>>,
>(extractors: T) {
	const result = {} as {
		[K in keyof T]: {
			type: K // 这里的 K 本身就被约束为 MetaType
			extract: T[K]
		}
	}
	for (const key of Object.keys(extractors) as Array<keyof T>) {
		result[key] = {
			type: key,
			extract: extractors[key]!,
		}
	}
	return result
}

// ❷ 只在这里维护一份映射，新增时只要加一行：
export const extractMap = buildRendererMap({
	string: extractStringProps,
	number: extractNumberProps,
	boolean: extractBooleanProps,
	picklist: extractPicklistProps,
})

export type ExtractMap = typeof extractMap

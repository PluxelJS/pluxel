// 深层嵌套的 schema 定义 - 用于测试跨文件导入
import * as v from 'valibot'

export const nestedSchema = v.object({
	apiKey: v.string(),
	endpoint: v.pipe(v.string(), v.url()),
	retryCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 3),
})

// 跨文件 schema 定义
import * as v from 'valibot'

export const externalSchema = v.object({
	host: v.string(),
	port: v.pipe(v.number(), v.minValue(1), v.maxValue(65535)),
})

export const anotherSchema = v.object({
	enabled: v.boolean(),
	timeout: v.optional(v.number(), 5000),
})

import * as v from 'valibot'

// 跨文件共享的 schema 片段
export const sharedArray = v.array(v.pipe(v.string(), v.minLength(1)))

export const sharedObject = v.object({
	flag: v.boolean(),
	array: sharedArray,
})

// 用于 spread 拼接的基础字段对象
export const baseFields = {
	name: v.string(),
	id: v.pipe(v.number(), v.integer()),
}

// 用于 shorthand 的单独 schema
export const enabledSchema = v.boolean()
export const countSchema = v.pipe(v.number(), v.minValue(0))

// 深层嵌套的 object
export const deepNested = v.object({
	level1: v.object({
		level2: v.object({
			value: v.string(),
		}),
	}),
})

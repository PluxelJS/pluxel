import * as v from 'valibot'

// 跨文件共享的 schema 片段
export const sharedArray = v.array(v.pipe(v.string(), v.minLength(1)))

export const sharedObject = v.object({
	flag: v.boolean(),
	array: sharedArray,
})

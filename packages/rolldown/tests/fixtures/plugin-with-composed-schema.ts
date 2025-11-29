import * as v from 'valibot'
import {
	baseFields,
	countSchema,
	deepNested,
	enabledSchema,
	sharedArray,
	sharedObject,
} from './composed-parts'

const localArray = v.array(v.number())
const localObject = v.object({
	array: localArray,
	external: sharedArray,
})

// 本地 shorthand 用的 schema
const timeout = v.optional(v.number(), 5000)

// 模拟 @pluxel/core 的装饰器
function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

function Config(_schema: any): PropertyDecorator {
	return () => {}
}

class BasePlugin {}

@Plugin({ name: 'ComposedPlugin' })
export class ComposedPlugin extends BasePlugin {
	// 1. 组合了本地 const
	@Config(localObject)
	private local!: any

	// 2. 组合了跨文件导入的 schema
	@Config(
		v.object({
			external: sharedObject,
			array: sharedArray,
		}),
	)
	private external!: any

	// 3. spread 拼接 - 跨文件的基础字段
	@Config(
		v.object({
			...baseFields,
			extra: v.boolean(),
		}),
	)
	private spread!: any

	// 4. shorthand 属性 - 跨文件 schema
	@Config(
		v.object({
			enabledSchema,
			countSchema,
		}),
	)
	private shorthand!: any

	// 5. 本地 shorthand
	@Config(
		v.object({
			timeout,
			name: v.string(),
		}),
	)
	private localShorthand!: any

	// 6. 深层嵌套 object
	@Config(deepNested)
	private nested!: any

	// 7. v.objectAsync 变体
	@Config(
		v.objectAsync({
			asyncField: v.string(),
			nested: sharedObject,
		}),
	)
	private asyncSchema!: any

	// 8. 混合场景：spread + shorthand + 跨文件
	@Config(
		v.object({
			...baseFields,
			enabledSchema,
			nested: sharedObject,
		}),
	)
	private mixed!: any
}

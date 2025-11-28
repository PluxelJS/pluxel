import * as v from 'valibot'
import { sharedArray, sharedObject } from './composed-parts'

const localArray = v.array(v.number())
const localObject = v.object({
	array: localArray,
	external: sharedArray,
})

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
	// 组合了本地 const
	@Config(localObject)
	private local!: any

	// 组合了跨文件导入的 schema
	@Config(
		v.object({
			external: sharedObject,
			array: sharedArray,
		}),
	)
	private external!: any
}

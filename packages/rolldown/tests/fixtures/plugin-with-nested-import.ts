// 测试直接跨文件导入 schema 的插件（不通过中间模块）
import * as v from 'valibot'
import { nestedSchema } from './nested-schema'

// 模拟 @pluxel/core 的装饰器
function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

function Config(_schema: any): PropertyDecorator {
	return () => {}
}

class BasePlugin {}

@Plugin({ name: 'NestedImportPlugin' })
export class NestedImportPlugin extends BasePlugin {
	// 通过中间模块导入的 schema
	@Config(nestedSchema)
	private nestedConfig!: any

	// 内联 schema 作为对照
	@Config(v.object({ inline: v.boolean() }))
	private inlineConfig!: any
}

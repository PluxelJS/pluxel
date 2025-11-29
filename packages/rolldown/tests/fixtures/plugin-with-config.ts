// 测试 @Config 源码提取的插件文件
import * as v from 'valibot'
import { externalSchema } from './schema'

// 本地定义的 schema
const localSchema = v.object({
	name: v.string(),
	count: v.pipe(v.number(), v.integer()),
})

// 模拟 @pluxel/core 的装饰器
function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

function Config(_schema: any): PropertyDecorator {
	return () => {}
}

class BasePlugin {}

@Plugin({ name: 'TestPlugin' })
export class TestPlugin extends BasePlugin {
	// 使用本地 schema
	@Config(localSchema)
	private localConfig!: any

	// 使用内联 schema
	@Config(v.object({ inline: v.boolean() }))
	private inlineConfig!: any

	// 使用跨文件导入的 schema
	@Config(externalSchema)
	private externalConfig!: any
}

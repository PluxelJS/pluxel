// 测试 import type 修复的插件文件
import type { SomeService } from './services'
import { type AnotherService, RegularImport } from './services'

// 模拟装饰器
function Plugin(_meta?: any): ClassDecorator {
	return () => {}
}

class BasePlugin {}

@Plugin({ name: 'TypeImportPlugin' })
export class TypeImportPlugin extends BasePlugin {
	constructor(
		private someService: SomeService,
		private anotherService: AnotherService,
		private regular: RegularImport,
	) {
		super()
	}
}

import type { Context } from '@pluxel/context'
// MathService.ts
import { Injectable } from '@pluxel/context'

/**
 * 模块声明合并：补全 Context 上的类型提示
 */
declare module '@pluxel/context' {
	namespace Context {
		interface Config {
			mathService?: { foo: string }
		}
	}
	interface Context {
		/** Service 实例 */
		mathService: MathService
		/** 快捷代理方法 */
		add(a: number, b: number): number
	}
}

class a {
	b = 'asd'
}
@Injectable
export class MathService extends a {
	/** 注入到 ctx.mathService */
	static key = 'mathService'
	/** 不需要额外配置，此例中可省略 configKey/defaultConfig */
	static methods = ['add'] as const

	constructor(
		private ctx: Context,
		private config: Context.Config['mathService'],
	) {
		super()
	}

	add(a: number, b: number): number {
		return a + b
	}

	getConfig() {
		return this.config
	}
}

import { type Context, Injectable } from '@pluxel/context'
import { EffectScopeService } from './EffectScopeService'

/**
 * 模块声明合并：补全 Context 上的类型提示
 */
declare module '@pluxel/context' {
	export interface Context {
		test: TestService
	}
}

@Injectable
export class TestService {
	static key = 'test'

	constructor(private ctx: Context) {}

	collect() {
		const test = () => {
			this.ctx.logger.info('test-collect')
		}
		this.ctx.collect(test)
		this.ctx.logger.info(
			`在 ${this.ctx.name} 添加了 test-collect`,
			this.ctx.scope.disposables.has(test),
		)
	}

	dispose() {
		this.ctx.disposeAll()
	}
}

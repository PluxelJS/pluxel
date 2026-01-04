import { type Context, Injectable } from '@pluxel/context'
import { EffectScopeService } from './EffectScopeService'

/**
 * 模块声明合并：补全 Context 上的类型提示
 */
declare module '@pluxel/context' {
	namespace Context {
		interface Services {
			test: TestService
		}
	}
}

@Injectable
export class TestService {
	static key = 'test'

	constructor(public ctx: Context) {}

	collect() {
		const test = () => {
			this.ctx.logger.info`test-collect`
		}
		this.ctx.collectEffect(test)
		this.ctx.logger
			.with({ registered: this.ctx.scope.disposables.has(test) })
			.info`在 ${this.ctx.name} 添加了 test-collect`
	}

	dispose() {
		this.ctx.disposeAll()
	}
}

import { type Context, Injectable } from '@pluxel/context'
import { EffectScopeService } from './EffectScopeService'

/**
 * 模块声明合并：补全 Context 上的类型提示
 */
declare module '@pluxel/context' {
	export interface Context {
		logger: LoggerService
	}
}

@Injectable
export class LoggerService {
	static key = 'logger'

	constructor(private ctx: Context) {}

	info = console.log
	error = console.error
}

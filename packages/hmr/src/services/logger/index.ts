import { type Context, Injectable, OverrideOf } from '@pluxel/core'
import { LoggerService } from '@pluxel/core/service'
import { createLogger, type Logger } from './createLogger'

// 1. 列出要转发的 log 级别
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
type Level = (typeof LEVELS)[number]

@OverrideOf(LoggerService)
@Injectable
export class PinoLoggerService {
	private static baseLogger: Logger
	public readonly logger: Logger

	// 2. 在类上声明属性，类型完全沿用原始 Logger 的方法签名
	//    使用 definite-assignment (!) 告诉 TS：我晚点在 constructor 里赋值
	public trace!: Logger['trace']
	public debug!: Logger['debug']
	public info!: Logger['info']
	public warn!: Logger['warn']
	public error!: Logger['error']
	public fatal!: Logger['fatal']

	constructor(private readonly ctx: Context) {
		if (PinoLoggerService.baseLogger) {
			this.logger = PinoLoggerService.baseLogger.child({
				name: ctx.pluginInfo.name ?? ctx.name,
			})
		} else {
			this.logger = PinoLoggerService.baseLogger = createLogger({
				name: ctx.name,
			})
		}

		// 3. 运行时把每个方法绑到 logger 实例上
		for (const level of LEVELS) {
			// 这里强转一下，方便 TS 识别 bind 后的类型仍是 Logger[Level]
			;(this as any)[level] = (this.logger[level] as Function).bind(this.logger)
		}
	}
}

import {
	type Context,
	Injectable,
	LoggerService,
	OverrideOf,
} from '@pluxel/core'
import { type Logger, createLogger } from './createLogger'
import superjson from 'superjson'
import type { LoggerOptions } from 'pino'

const superjsonLog: NonNullable<LoggerOptions['formatters']>['log'] = (obj) => {
	const { json, meta } = superjson.serialize(obj)

	// json 必须是对象才能直接返回；否则包到 { value: ... }
	if (json && typeof json === 'object' && !Array.isArray(json)) {
		return Object.keys(meta ?? {}).length
			? { ...json }
			: (json as Record<string, unknown>)
	}
	// 保底：顶层不是对象时也满足 pino 的返回类型要求
	return Object.keys(meta ?? {}).length ? { value: json } : { value: json }
}

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
				name: ctx.pluginInfo.meta.name ?? ctx.name,
			})
		} else {
			this.logger = PinoLoggerService.baseLogger = createLogger({
				name: ctx.name,
				formatters: { log: superjsonLog },
			})
		}

		// 3. 运行时把每个方法绑到 logger 实例上
		for (const level of LEVELS) {
			// 这里强转一下，方便 TS 识别 bind 后的类型仍是 Logger[Level]
			;(this as any)[level] = (this.logger[level] as Function).bind(this.logger)
		}
	}
}

import { type Context, Injectable, OverrideOf } from '@pluxel/core'
import { LoggerService } from '@pluxel/core/service'
import type { Bindings, Logger } from 'pino'
import { createLogger } from './createLogger'

// 1. 列出要转发的 log 级别
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
type Level = (typeof LEVELS)[number]

@OverrideOf(LoggerService)
@Injectable
export class PinoLoggerService {
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
		const scopeName = ctx.pluginInfo?.name ?? ctx.name
		const bindings: Bindings = {
			name: scopeName,
			scope: scopeName,
		}
		const pluginName = ctx.pluginInfo?.name
		if (pluginName && pluginName !== scopeName) {
			bindings.plugin = pluginName
		}
		this.logger = deriveScopedLogger(bindings)

		this.bindLevels()
	}

	private bindLevels() {
		for (const level of LEVELS) {
			;(this as any)[level] = (this.logger[level] as Function).bind(this.logger)
		}
	}
}

let rootLogger: Logger | undefined

function getRootLogger(): Logger {
	if (!rootLogger) {
		const defaultName = process.env.PLUXEL_LOGGER_NAME?.trim() || 'root'
		rootLogger = createLogger({ name: defaultName })
	}
	return rootLogger
}

function deriveScopedLogger(bindings: Bindings): Logger {
	const root = getRootLogger()
	return bindings ? root.child(bindings) : root
}

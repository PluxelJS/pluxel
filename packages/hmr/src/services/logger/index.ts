import { type Context, Injectable, OverrideOf } from '@pluxel/core'
import { LoggerService } from '@pluxel/core/services'
import type { Bindings, Logger } from 'pino'
import { createLogger } from './createLogger'

// 1. 列出要转发的 log 级别
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const

@Injectable
@OverrideOf(LoggerService)
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
		const isProd = process.env.NODE_ENV === 'production'

		// #if NODE_ENV !== 'production'
		if (!isProd) {
			const scopeName = ctx.pluginInfo?.id ?? ctx.name
			const bindings: Bindings = {
				name: scopeName,
			}
			const pluginId = ctx.pluginInfo?.id
			if (pluginId && pluginId !== scopeName) {
				bindings.plugin = pluginId
			}
			this.logger = deriveScopedLogger(bindings)
			this.bindLevels()
			return
		}
		// #endif

		// #if NODE_ENV === 'production'
		this.logger = console as unknown as Logger
		this.bindNoopLevels()
		// #endif
	}

	private bindLevels() {
		if (process.env.NODE_ENV !== 'production') {
			for (const level of LEVELS) {
				;(this as any)[level] = (this.logger[level] as Function).bind(this.logger)
			}
		} else {
			this.bindNoopLevels()
		}
	}

	private bindNoopLevels() {
		const noop = () => {}
		for (const level of LEVELS) {
			;(this as any)[level] = noop
		}
	}
}

// #if NODE_ENV !== 'production'
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
// #endif

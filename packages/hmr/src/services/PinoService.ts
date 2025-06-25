import {
	type Context,
	Injectable,
	LoggerService,
	OverrideOf,
} from '@pluxel/core'
import pino, { type Logger } from 'pino'

@OverrideOf(LoggerService)
@Injectable
export class PinoLoggerService {
	private logger: Logger

	constructor(private ctx: Context) {
		// 用 ctx.name 做 logger 名称，保持与原来一致
		this.logger = pino({ name: ctx.name })
	}

	trace(...args: unknown[]): void {
		this.logger.trace(...(args as [any, ...any[]]))
	}
	debug(...args: unknown[]): void {
		this.logger.debug(...(args as [any, ...any[]]))
	}
	info(...args: unknown[]): void {
		this.logger.info(...(args as [any, ...any[]]))
	}
	warn(...args: unknown[]): void {
		this.logger.warn(...(args as [any, ...any[]]))
	}
	error(...args: unknown[]): void {
		this.logger.error(...(args as [any, ...any[]]))
	}
	fatal(...args: unknown[]): void {
		this.logger.fatal?.(...(args as [any, ...any[]])) // pino ≥7 支持 fatal
	}
}

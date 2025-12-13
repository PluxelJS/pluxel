import { type Context, Injectable, OverrideOf } from '@pluxel/core'
import { LoggerService } from '@pluxel/core/services'
import type { Bindings, LevelWithSilent, Logger } from 'pino'
import { createLogger } from './createLogger'
import {
	LEVEL_WEIGHTS,
	type PinoLoggerConfig,
	type ResolvedPinoLoggerConfig,
	resolvePinoLoggerConfig,
} from './pinoLoggerConfig'

export type { PinoLoggerConfig, ResolvedPinoLoggerConfig } from './pinoLoggerConfig'
export { resolvePinoLoggerConfig } from './pinoLoggerConfig'

const noop = () => undefined
const noopPino = noop as unknown as Logger['info']

function asPinoFn(fn: (...args: unknown[]) => void): Logger['info'] {
	return fn as unknown as Logger['info']
}

@Injectable
@OverrideOf(LoggerService)
export class PinoLoggerService {
	public readonly logger: Logger
	private readonly config: ResolvedPinoLoggerConfig

	public trace: Logger['trace'] = noopPino
	public debug: Logger['debug'] = noopPino
	public info: Logger['info'] = noopPino
	public warn: Logger['warn'] = noopPino
	public error: Logger['error'] = noopPino
	public fatal: Logger['fatal'] = noopPino

	constructor(ctx: Context, config: PinoLoggerConfig = {}) {
		this.config = resolvePinoLoggerConfig(config)
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
			this.logger = deriveScopedLogger(bindings, this.config)
			this.bindPinoLevels(this.logger)
			return
		}
		// #endif

		// #if NODE_ENV === 'production'
		this.logger = console as unknown as Logger
		if (this.config.production.enabled) {
			this.bindConsoleLevels(this.config.production.level)
		} else {
			this.bindNoopLevels()
		}
		// #endif
	}

	private bindPinoLevels(logger: Logger) {
		this.trace = logger.trace.bind(logger)
		this.debug = logger.debug.bind(logger)
		this.info = logger.info.bind(logger)
		this.warn = logger.warn.bind(logger)
		this.error = logger.error.bind(logger)
		this.fatal = logger.fatal.bind(logger)
	}

	private bindConsoleLevels(minLevel: LevelWithSilent) {
		const threshold = LEVEL_WEIGHTS[minLevel] ?? LEVEL_WEIGHTS.info

		const traceImpl =
			LEVEL_WEIGHTS.trace < threshold
				? noop
				: (console.trace?.bind(console) ?? console.log.bind(console))
		const debugImpl =
			LEVEL_WEIGHTS.debug < threshold
				? noop
				: (console.debug?.bind(console) ?? console.log.bind(console))
		const infoImpl =
			LEVEL_WEIGHTS.info < threshold
				? noop
				: (console.info?.bind(console) ?? console.log.bind(console))
		const warnImpl =
			LEVEL_WEIGHTS.warn < threshold
				? noop
				: (console.warn?.bind(console) ?? console.log.bind(console))
		const errorImpl =
			LEVEL_WEIGHTS.error < threshold
				? noop
				: (console.error?.bind(console) ?? console.log.bind(console))

		this.trace = asPinoFn(traceImpl) as Logger['trace']
		this.debug = asPinoFn(debugImpl) as Logger['debug']
		this.info = asPinoFn(infoImpl) as Logger['info']
		this.warn = asPinoFn(warnImpl) as Logger['warn']
		this.error = asPinoFn(errorImpl) as Logger['error']
		this.fatal = asPinoFn(errorImpl) as Logger['fatal']
	}

	private bindNoopLevels() {
		this.trace = noopPino
		this.debug = noopPino
		this.info = noopPino
		this.warn = noopPino
		this.error = noopPino
		this.fatal = noopPino
	}
}

// #if NODE_ENV !== 'production'
let rootLogger: Logger | undefined
let rootLoggerLevel: LevelWithSilent | undefined
let rootLoggerName: string | undefined

function getRootLogger(config: ResolvedPinoLoggerConfig): Logger {
	if (!rootLogger || rootLoggerName !== config.name) {
		rootLogger = createLogger({ name: config.name, level: config.level })
		rootLoggerLevel = config.level
		rootLoggerName = config.name
		return rootLogger
	}
	const desiredLevel = config.level
	if (rootLoggerLevel !== desiredLevel) {
		rootLogger.level = desiredLevel
		rootLoggerLevel = desiredLevel
	}
	return rootLogger
}

function deriveScopedLogger(bindings: Bindings, config: ResolvedPinoLoggerConfig): Logger {
	const root = getRootLogger(config)
	return bindings ? root.child(bindings) : root
}
// #endif

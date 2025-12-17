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

/** 向上遍历 context 链查找 pluginInfo.id */
function findPluginId(ctx: Context): string | undefined {
	let current: Context | undefined = ctx
	while (current) {
		const info = current.pluginInfo as Context['pluginInfo'] | undefined
		if (info && info.id) return info.id
		current = current.parent ?? current.caller
	}
	return undefined
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

		const bindings: Bindings = {
			// name 保持当前 context 名称，用于显示
			name: ctx.name,
		}
		// pluginId 用于前端过滤
		const pluginId = findPluginId(ctx)
		if (pluginId) {
			bindings.pluginId = pluginId
		}
		this.logger = deriveScopedLogger(bindings, this.config)
		this.bindPinoLevels(this.logger)
	}

	private bindPinoLevels(logger: Logger) {
		this.trace = logger.trace.bind(logger)
		this.debug = logger.debug.bind(logger)
		this.info = logger.info.bind(logger)
		this.warn = logger.warn.bind(logger)
		this.error = logger.error.bind(logger)
		this.fatal = logger.fatal.bind(logger)
	}
}

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

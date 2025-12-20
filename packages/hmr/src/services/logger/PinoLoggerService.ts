import { type Context, Injectable, OverrideOf } from '@pluxel/core'
import { LoggerService } from '@pluxel/core/services'
import type { Bindings, LevelWithSilent, Logger } from 'pino'
import { createLogger } from './createLogger'
import {
	type PinoLoggerConfig,
	type ResolvedPinoLoggerConfig,
	resolvePinoLoggerConfig,
} from './pinoLoggerConfig'
import { formatLogName } from './logName'

export type { PinoLoggerConfig, ResolvedPinoLoggerConfig } from './pinoLoggerConfig'
export { resolvePinoLoggerConfig } from './pinoLoggerConfig'

const noop = () => undefined
const noopPino = noop as unknown as Logger['info']

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
	private _logger!: Logger
	private readonly config: ResolvedPinoLoggerConfig
	private _ctx: Context

	public trace: Logger['trace'] = noopPino
	public debug: Logger['debug'] = noopPino
	public info: Logger['info'] = noopPino
	public warn: Logger['warn'] = noopPino
	public error: Logger['error'] = noopPino
	public fatal: Logger['fatal'] = noopPino

	constructor(ctx: Context, config: PinoLoggerConfig = {}) {
		this._ctx = ctx
		this.config = resolvePinoLoggerConfig(config)

		const pluginId = findPluginId(ctx)
		const name = formatLogName(ctx.name, pluginId)
		const bindings: Bindings = pluginId
			? {
					// name 用于展示/筛选，pluginId/context 便于简单过滤
					name,
					pluginId,
					context: ctx.name,
				}
			: {
					name,
				}
		this._logger = deriveScopedLogger(bindings, this.config)
		this.bindPinoLevels(this._logger)
	}

	public get logger(): Logger {
		return this._logger
	}

	public get ctx(): Context {
		return this._ctx
	}

	public set ctx(ctx: Context) {
		if (this._ctx && ctx !== this._ctx) {
			throw new Error(
				'[PinoLoggerService] Logger context was rebound. Use registry.pluginCTXIsolate: [PinoLoggerService] to scope per-plugin instances.',
			)
		}
		this._ctx = ctx
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

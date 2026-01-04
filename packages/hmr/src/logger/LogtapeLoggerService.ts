import { getLogger, type Logger as LogtapeLogger } from '@logtape/logtape'
import { type Context, Injectable, OverrideOf } from '@pluxel/core'
import {
	callLogtape,
	type PluxelLogMethod,
	captureCaller,
	findPluginId,
	isCallerEnabled,
	pluxelCategories,
} from '@pluxel/core/logger'
import { LoggerService } from '@pluxel/core/services'

import { formatLogName } from './logName'

type ContextLoggerCacheEntry = {
	hmr: LogtapeLogger
	plugin?: { id: string; logger: LogtapeLogger }
}

const contextLoggerCache = new WeakMap<object, ContextLoggerCacheEntry>()

@Injectable
@OverrideOf(LoggerService)
export class LogtapeLoggerService {
	public readonly ctx: Context
	private readonly hmrLogger: LogtapeLogger
	private readonly pluginsLogger: LogtapeLogger

	constructor(ctx: Context) {
		this.ctx = ctx
		this.hmrLogger = getLogger(pluxelCategories.hmr)
		this.pluginsLogger = getLogger(pluxelCategories.plugins)
	}

	private getBaseContextLogger(): LogtapeLogger {
		const key = this.ctx as any as object
		let cached = contextLoggerCache.get(key)
		if (!cached) {
			cached = { hmr: this.hmrLogger.with({ context: this.ctx.name, name: this.ctx.name }) }
			contextLoggerCache.set(key, cached)
		}

		if (cached.plugin) return cached.plugin.logger

		const pluginId = findPluginId(this.ctx)
		if (pluginId) {
			cached.plugin = {
				id: pluginId,
				logger: this.pluginsLogger.with({
					context: this.ctx.name,
					pluginId,
					name: formatLogName(this.ctx.name, pluginId),
				}),
			}
			return cached.plugin.logger
		}

		return cached.hmr
	}

	private getContextLogger(
		extra: Record<string, unknown> | undefined,
		includeCaller: boolean,
		exclude?: Function,
	) {
		const base = this.getBaseContextLogger()
		let props: Record<string, unknown> | undefined = extra
		if (includeCaller && isCallerEnabled()) {
			const caller = captureCaller({ exclude: exclude ?? this.log })
			if (caller) props = props ? { ...props, caller } : { caller }
		}
		return props ? base.with(props) : base
	}

	private log(
		level: PluxelLogMethod,
		args: unknown[],
	) {
		const logger = this.getContextLogger(undefined, true, this.log)
		callLogtape(logger, level, args)
	}

	public trace: LogtapeLogger['trace'] = ((...args: any[]) => this.log('trace', args)) as any
	public debug: LogtapeLogger['debug'] = ((...args: any[]) => this.log('debug', args)) as any
	public info: LogtapeLogger['info'] = ((...args: any[]) => this.log('info', args)) as any
	public warn: LogtapeLogger['warn'] = ((...args: any[]) => this.log('warn', args)) as any
	public error: LogtapeLogger['error'] = ((...args: any[]) => this.log('error', args)) as any
	public fatal: LogtapeLogger['fatal'] = ((...args: any[]) => this.log('fatal', args)) as any

	/** Create a LogTape logger that inherits pluxel context fields. */
	public with(properties: Record<string, unknown>): LogtapeLogger {
		// Capture caller at the `.with()` call-site so the returned logger keeps it
		// even when used with LogTape's contextual logger pattern.
		return this.getContextLogger(properties, true, this.with)
	}
}

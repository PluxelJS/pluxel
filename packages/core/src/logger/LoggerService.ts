import { getLogger, type Logger as LogtapeLogger } from '@logtape/logtape'
import { type Context, Injectable } from '@pluxel/context'
import { type PluxelLogMethod, callLogtape } from './logCall'
import { captureCaller, isCallerEnabled } from './caller'
import { pluxelCategories } from './categories'
import { findPluginId } from './context'

type ContextLoggerCacheEntry = {
	core: LogtapeLogger
	plugin?: { id: string; logger: LogtapeLogger }
}

const contextLoggerCache = new WeakMap<object, ContextLoggerCacheEntry>()

const serviceName = 'logger' as const
declare module '@pluxel/context' {
	namespace Context {
		interface Services {
			[serviceName]: LoggerService
		}
	}
}

@Injectable({
	key: serviceName,
})
export class LoggerService {
	public readonly ctx: Context
	private readonly coreLogger: LogtapeLogger
	private readonly pluginsLogger: LogtapeLogger

	constructor(ctx: Context) {
		this.ctx = ctx
		this.coreLogger = getLogger(pluxelCategories.core)
		this.pluginsLogger = getLogger(pluxelCategories.plugins)
	}

	private getBaseContextLogger(): LogtapeLogger {
		const key = this.ctx as any as object
		let cached = contextLoggerCache.get(key)
		if (!cached) {
			cached = { core: this.coreLogger.with({ context: this.ctx.name }) }
			contextLoggerCache.set(key, cached)
		}

		if (cached.plugin) return cached.plugin.logger

		const pluginId = findPluginId(this.ctx)
		if (pluginId) {
			cached.plugin = {
				id: pluginId,
				logger: this.pluginsLogger.with({ context: this.ctx.name, pluginId }),
			}
			return cached.plugin.logger
		}

		return cached.core
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

	private log(level: PluxelLogMethod, args: unknown[]) {
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

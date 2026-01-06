import { getLogger, type Logger as LogtapeLogger } from '@logtape/logtape'
import { type Context, Injectable } from '@pluxel/context'
import { captureCaller, isCallerEnabled } from './caller'
import { pluxelCategories } from './categories'
import { findPluginId } from './context'
import { callLogtape, type PluxelLogMethod } from './logCall'

type ContextLoggerCacheEntry = {
	core: LogtapeLogger
	plugin?: { id: string; logger: LogtapeLogger }
	debug?: { core: LogtapeLogger; plugin?: { id: string; logger: LogtapeLogger } }
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
	private readonly debugLogger: LogtapeLogger

	constructor(ctx: Context) {
		this.ctx = ctx
		this.coreLogger = getLogger(pluxelCategories.core)
		this.pluginsLogger = getLogger(pluxelCategories.plugins)
		this.debugLogger = getLogger(['pluxel', 'debug'])
	}

	private getBaseContextLogger(): LogtapeLogger {
		const key = this.ctx as unknown as object
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

	private getDebugBaseLogger(): LogtapeLogger {
		const key = this.ctx as unknown as object
		let cached = contextLoggerCache.get(key)
		if (!cached) {
			cached = { core: this.coreLogger.with({ context: this.ctx.name }) }
			contextLoggerCache.set(key, cached)
		}

		if (!cached.debug) {
			cached.debug = { core: this.debugLogger.with({ context: this.ctx.name }) }
		}

		if (cached.debug.plugin) return cached.debug.plugin.logger

		// Reuse cached plugin id if it already exists from normal logging.
		const pluginId = cached.plugin?.id ?? findPluginId(this.ctx)
		if (pluginId) {
			cached.debug.plugin = {
				id: pluginId,
				logger: cached.debug.core.with({ pluginId }),
			}
			return cached.debug.plugin.logger
		}

		return cached.debug.core
	}

	private getContextLogger(
		extra: Record<string, unknown> | undefined,
		includeCaller: boolean,
		exclude?: (...args: never[]) => unknown,
	) {
		const base = this.getBaseContextLogger()
		if (!includeCaller || !isCallerEnabled()) return extra ? base.with(extra) : base

		let props: Record<string, unknown> | undefined = extra
		if (!props || typeof props.caller !== 'string') {
			const caller = captureCaller({ exclude: exclude ?? this.log })
			if (caller) props = props ? { ...props, caller } : { caller }
		}
		return props ? base.with(props) : base
	}

	private log(level: PluxelLogMethod, args: unknown[]) {
		const logger = this.getContextLogger(undefined, true, this.log)
		callLogtape(logger, level, args)
	}

	private levelMethod(level: PluxelLogMethod) {
		return (...args: unknown[]) => this.log(level, args)
	}

	public trace = this.levelMethod('trace') as unknown as LogtapeLogger['trace']
	public debug = this.levelMethod('debug') as unknown as LogtapeLogger['debug']
	public info = this.levelMethod('info') as unknown as LogtapeLogger['info']
	public warn = this.levelMethod('warn') as unknown as LogtapeLogger['warn']
	public error = this.levelMethod('error') as unknown as LogtapeLogger['error']
	public fatal = this.levelMethod('fatal') as unknown as LogtapeLogger['fatal']

	/** Create a LogTape logger that inherits pluxel context fields. */
	public with(properties: Record<string, unknown>): LogtapeLogger {
		// Don't capture `caller` here: it would freeze the call-site of `.with()` for all subsequent logs.
		return this.getContextLogger(properties, false)
	}

	/**
	 * Get a dedicated debug channel logger for a topic.
	 *
	 * - category: `["pluxel","debug"]`
	 * - properties: `{ debugTopic, context, pluginId? }`
	 *
	 * This is intended to replace scattered `getLogger([...])` debug usage in services.
	 */
	public getDebugChannel(debugTopic: string): LogtapeLogger {
		// Note: prefer caching the base debug logger to avoid repeated `.with({context,...})` wrapping.
		return this.getDebugBaseLogger().with({ debugTopic })
	}
}

import { getLogger, type Logger as LogtapeLogger, lazy } from '@logtape/logtape'
import { type Context, Injectable, OverrideOf } from '@pluxel/core'
import {
	callLogtape,
	captureCaller,
	findPluginId,
	isCallerEnabled,
	type PluxelLogMethod,
	pluxelCategories,
} from '@pluxel/core/logger'
import { LoggerService } from '@pluxel/core/services'

import { formatLogName } from './logName'

type ContextLoggerCacheEntry = {
	hmr: LogtapeLogger
	plugin?: { id: string; logger: LogtapeLogger }
	debug?: { hmr: LogtapeLogger; plugin?: { id: string; logger: LogtapeLogger } }
}

const contextLoggerCache = new WeakMap<object, ContextLoggerCacheEntry>()

@Injectable
@OverrideOf(LoggerService)
export class LogtapeLoggerService extends LoggerService {
	private readonly hmrLogger: LogtapeLogger
	private readonly pluginsCategoryLogger: LogtapeLogger
	private readonly debugCategoryLogger: LogtapeLogger

	constructor(ctx: Context) {
		super(ctx)
		this.hmrLogger = getLogger(pluxelCategories.hmr)
		this.pluginsCategoryLogger = getLogger(pluxelCategories.plugins)
		this.debugCategoryLogger = getLogger(['pluxel', 'debug'])
	}

	private getBaseContextLogger(): LogtapeLogger {
		const key = this.ctx as unknown as object
		let cached = contextLoggerCache.get(key)
		if (!cached) {
			cached = {
				hmr: this.hmrLogger.with(
					isCallerEnabled()
						? { context: this.ctx.name, name: this.ctx.name, caller: lazy(() => captureCaller()) }
						: { context: this.ctx.name, name: this.ctx.name },
				),
			}
			contextLoggerCache.set(key, cached)
		}

		if (cached.plugin) return cached.plugin.logger

		const pluginId = findPluginId(this.ctx)
		if (pluginId) {
			cached.plugin = {
				id: pluginId,
				logger: this.pluginsCategoryLogger.with(
					isCallerEnabled()
						? {
								context: this.ctx.name,
								pluginId,
								name: formatLogName(this.ctx.name, pluginId),
								caller: lazy(() => captureCaller()),
							}
						: {
								context: this.ctx.name,
								pluginId,
								name: formatLogName(this.ctx.name, pluginId),
							},
				),
			}
			return cached.plugin.logger
		}

		return cached.hmr
	}

	private getDebugBaseContextLogger(): LogtapeLogger {
		const key = this.ctx as unknown as object
		let cached = contextLoggerCache.get(key)
		if (!cached) {
			cached = {
				hmr: this.hmrLogger.with(
					isCallerEnabled()
						? { context: this.ctx.name, name: this.ctx.name, caller: lazy(() => captureCaller()) }
						: { context: this.ctx.name, name: this.ctx.name },
				),
			}
			contextLoggerCache.set(key, cached)
		}

		if (!cached.debug) {
			cached.debug = {
				hmr: this.debugCategoryLogger.with(
					isCallerEnabled()
						? { context: this.ctx.name, name: this.ctx.name, caller: lazy(() => captureCaller()) }
						: { context: this.ctx.name, name: this.ctx.name },
				),
			}
		}
		if (cached.debug.plugin) return cached.debug.plugin.logger

		// Reuse cached plugin id if it already exists from normal logging.
		const pluginId = cached.plugin?.id ?? findPluginId(this.ctx)
		if (pluginId) {
			cached.debug.plugin = {
				id: pluginId,
				logger: cached.debug.hmr.with({
					pluginId,
					name: formatLogName(this.ctx.name, pluginId),
				}),
			}
			return cached.debug.plugin.logger
		}

		return cached.debug.hmr
	}

	private logHmr(level: PluxelLogMethod, args: unknown[]) {
		callLogtape(this.getBaseContextLogger(), level, args)
	}

	private makeLevelMethod(level: PluxelLogMethod) {
		return (...args: unknown[]) => this.logHmr(level, args)
	}

	public override trace = this.makeLevelMethod('trace') as unknown as LogtapeLogger['trace']
	public override debug = this.makeLevelMethod('debug') as unknown as LogtapeLogger['debug']
	public override info = this.makeLevelMethod('info') as unknown as LogtapeLogger['info']
	public override warn = this.makeLevelMethod('warn') as unknown as LogtapeLogger['warn']
	public override error = this.makeLevelMethod('error') as unknown as LogtapeLogger['error']
	public override fatal = this.makeLevelMethod('fatal') as unknown as LogtapeLogger['fatal']

	/** Create a LogTape logger that inherits pluxel context fields. */
	public override with(properties: Record<string, unknown>): LogtapeLogger {
		return this.getBaseContextLogger().with(properties)
	}

	/**
	 * Get a dedicated debug channel logger for a topic.
	 *
	 * - category: `["pluxel","debug"]`
	 * - properties: `{ debugTopic, context, name, pluginId? }`
	 */
	public override getDebugChannel(debugTopic: string): LogtapeLogger {
		return this.getDebugBaseContextLogger().with({ debugTopic })
	}
}

import { getLogger, type Logger as LogtapeLogger } from '@logtape/logtape'
import { type Context, Injectable } from '@pluxel/context'
import { getPluxelRuntime } from '../env'
import { pluxelCategories } from './categories'
import { findPluginId } from './context'
import { callLogtape, type PluxelLogMethod } from './logCall'
import { formatLogName } from './name'

type ContextLoggerCacheEntry = {
	base: LogtapeLogger
	plugin?: { id: string; logger: LogtapeLogger }
	debug?: { base: LogtapeLogger; plugin?: { id: string; logger: LogtapeLogger } }
}

const serviceName = 'logger' as const
declare module '@pluxel/context' {
	namespace Context {
		interface Config {
			[serviceName]?: LoggerServiceConfig
		}
		interface Services {
			[serviceName]: LoggerService
		}
	}
}

export type LoggerServicePreset = 'core' | 'hmr'

export type LoggerServiceConfig = {
	/**
	 * Logging preset:
	 * - `core`: `pluxelCategories.core`, no `name` field by default
	 * - `hmr`: `pluxelCategories.hmr`, inject `name` by default (for pretty prefix)
	 *
	 * Default: inferred from `getPluxelRuntime()` (set by `@pluxel/hmr` entry).
	 */
	preset?: LoggerServicePreset

	/** Override the base category (non-plugin contexts). */
	baseCategory?: readonly string[]
	/** Override the plugins category. */
	pluginCategory?: readonly string[]
	/** Override the debug channel category. */
	debugCategory?: readonly string[]

	/**
	 * Inject `record.properties.name`.
	 *
	 * - `false`: disabled (default for `core` preset)
	 * - `true`: enabled (default for `hmr` preset; uses `formatLogName()`)
	 * - function: custom naming (called with `ctxName` and optional `pluginId`)
	 */
	name?: boolean | ((ctxName: string, pluginId?: string) => string)
}

@Injectable({
	key: serviceName,
})
export class LoggerService {
	public readonly ctx: Context
	private readonly baseCategoryLogger: LogtapeLogger
	private readonly pluginsCategoryLogger: LogtapeLogger
	private readonly debugCategoryLogger: LogtapeLogger
	private readonly nameFn: ((ctxName: string, pluginId?: string) => string) | null
	private readonly cache = new WeakMap<object, ContextLoggerCacheEntry>()
	private readonly debugChannelCache = new Map<string, LogtapeLogger>()

	constructor(ctx: Context, cfg?: LoggerServiceConfig) {
		this.ctx = ctx

		const preset: LoggerServicePreset =
			cfg?.preset ?? (getPluxelRuntime() === 'hmr' ? 'hmr' : 'core')

		const baseCategory =
			cfg?.baseCategory ?? (preset === 'hmr' ? pluxelCategories.hmr : pluxelCategories.core)
		const pluginCategory = cfg?.pluginCategory ?? pluxelCategories.plugins
		const debugCategory = cfg?.debugCategory ?? (['pluxel', 'debug'] as const)

		// Avoid per-service allocations; LogTape does not mutate category arrays.
		this.baseCategoryLogger = getLogger(baseCategory as unknown as string[])
		this.pluginsCategoryLogger = getLogger(pluginCategory as unknown as string[])
		this.debugCategoryLogger = getLogger(debugCategory as unknown as string[])

		const nameOpt = cfg?.name ?? preset === 'hmr'
		if (nameOpt === false) this.nameFn = null
		else if (typeof nameOpt === 'function') this.nameFn = nameOpt
		else if (nameOpt === true) this.nameFn = formatLogName
		else this.nameFn = null
	}

	private getBaseContextLogger(): LogtapeLogger {
		const key = this.ctx as unknown as object
		let cached = this.cache.get(key)
		if (!cached) {
			const baseProps: Record<string, unknown> = { context: this.ctx.name }
			if (this.nameFn) baseProps.name = this.nameFn(this.ctx.name)

			cached = {
				base: this.baseCategoryLogger.with(baseProps),
			}
			this.cache.set(key, cached)
		}

		if (cached.plugin) return cached.plugin.logger

		const pluginId = findPluginId(this.ctx)
		if (pluginId) {
			const pluginProps: Record<string, unknown> = { context: this.ctx.name, pluginId }
			if (this.nameFn) pluginProps.name = this.nameFn(this.ctx.name, pluginId)

			cached.plugin = {
				id: pluginId,
				logger: this.pluginsCategoryLogger.with(pluginProps),
			}
			return cached.plugin.logger
		}

		return cached.base
	}

	private getDebugBaseLogger(): LogtapeLogger {
		const key = this.ctx as unknown as object
		let cached = this.cache.get(key)
		if (!cached) {
			const baseProps: Record<string, unknown> = { context: this.ctx.name }
			if (this.nameFn) baseProps.name = this.nameFn(this.ctx.name)

			cached = {
				base: this.baseCategoryLogger.with(baseProps),
			}
			this.cache.set(key, cached)
		}

		if (!cached.debug) {
			const baseProps: Record<string, unknown> = { context: this.ctx.name }
			if (this.nameFn) baseProps.name = this.nameFn(this.ctx.name)

			cached.debug = {
				base: this.debugCategoryLogger.with(baseProps),
			}
		}

		if (cached.debug.plugin) return cached.debug.plugin.logger

		// Reuse cached plugin id if it already exists from normal logging.
		const pluginId = cached.plugin?.id ?? findPluginId(this.ctx)
		if (pluginId) {
			const pluginProps: Record<string, unknown> = { pluginId }
			if (this.nameFn) pluginProps.name = this.nameFn(this.ctx.name, pluginId)

			cached.debug.plugin = {
				id: pluginId,
				logger: cached.debug.base.with(pluginProps),
			}
			return cached.debug.plugin.logger
		}

		return cached.debug.base
	}

	private log(level: PluxelLogMethod, args: unknown[]) {
		callLogtape(this.getBaseContextLogger(), level, args)
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
		return this.getBaseContextLogger().with(properties)
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
		// Note: cache per-topic `.with({debugTopic})` wrappers to keep debug-heavy loops cheap.
		const cached = this.debugChannelCache.get(debugTopic)
		if (cached) return cached
		const next = this.getDebugBaseLogger().with({ debugTopic })
		this.debugChannelCache.set(debugTopic, next)
		return next
	}
}

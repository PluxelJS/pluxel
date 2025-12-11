import { type Context, Injectable, OverrideOf } from '@pluxel/core'
import { LoggerService } from '@pluxel/core/services'
import type { Bindings, LevelWithSilent, Logger } from 'pino'
import { createLogger } from './createLogger'

// 1. 列出要转发的 log 级别
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
const VALID_LEVELS = new Set<LevelWithSilent>([
	'fatal',
	'error',
	'warn',
	'info',
	'debug',
	'trace',
	'silent',
])
const LEVEL_WEIGHTS: Record<LevelWithSilent, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
	silent: Number.POSITIVE_INFINITY,
}
const DEFAULT_LOGGER_NAME = process.env.PLUXEL_LOGGER_NAME?.trim() || 'root'
const DEFAULT_LOG_LEVEL = normalizeLevel(
	process.env.PLUXEL_LOG_LEVEL ?? process.env.PLUXEL_LOGGER_LEVEL ?? process.env.LOG_LEVEL,
	'info',
)

export interface PinoLoggerConfig {
	/** 非生产环境下的日志级别（默认 info，可被 LOG_LEVEL 等环境变量覆盖） */
	level?: LevelWithSilent
	/** 根 logger 名称（默认 PLUXEL_LOGGER_NAME 或 root） */
	name?: string
	/** 生产环境行为（默认保持沉默，与现有行为一致） */
	production?: {
		enabled?: boolean
		level?: LevelWithSilent
	}
}

export interface ResolvedPinoLoggerConfig {
	level: LevelWithSilent
	name: string
	production: {
		enabled: boolean
		level: LevelWithSilent
	}
}

type ProductionConfig = NonNullable<PinoLoggerConfig['production']>
const DEFAULT_CONFIG: ResolvedPinoLoggerConfig = {
	level: DEFAULT_LOG_LEVEL,
	name: DEFAULT_LOGGER_NAME,
	production: {
		enabled: false,
		level: DEFAULT_LOG_LEVEL,
	},
}

export function resolvePinoLoggerConfig(config: PinoLoggerConfig = {}): ResolvedPinoLoggerConfig {
	const baseLevel = normalizeLevel(config.level, DEFAULT_CONFIG.level)
	const prod: ProductionConfig = config.production ?? {}
	const prodLevel = normalizeLevel(prod.level, baseLevel)
	return {
		level: baseLevel,
		name: config.name?.trim() || DEFAULT_CONFIG.name,
		production: {
			enabled: prod.enabled ?? DEFAULT_CONFIG.production.enabled,
			level: prodLevel,
		},
	}
}

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			logger?: PinoLoggerConfig
		}
	}
}

const noop = () => {}

@Injectable
@OverrideOf(LoggerService)
export class PinoLoggerService {
	public readonly logger: Logger
	private readonly config: ResolvedPinoLoggerConfig

	// 2. 在类上声明属性，类型完全沿用原始 Logger 的方法签名
	//    使用 definite-assignment (!) 告诉 TS：我晚点在 constructor 里赋值
	public trace!: Logger['trace']
	public debug!: Logger['debug']
	public info!: Logger['info']
	public warn!: Logger['warn']
	public error!: Logger['error']
	public fatal!: Logger['fatal']

	constructor(private readonly ctx: Context, config: PinoLoggerConfig = {}) {
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
			this.bindLevels()
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

	private bindLevels() {
		for (const level of LEVELS) {
			const method = this.logger[level] as Function | undefined
			;(this as any)[level] = typeof method === 'function' ? method.bind(this.logger) : noop
		}
	}

	private bindConsoleLevels(minLevel: LevelWithSilent) {
		const threshold = LEVEL_WEIGHTS[minLevel] ?? LEVEL_WEIGHTS.info
		for (const level of LEVELS) {
			if (LEVEL_WEIGHTS[level] < threshold) {
				;(this as any)[level] = noop
				continue
			}
			const target = (console as any)[level] as Function | undefined
			const fallback = level === 'fatal' ? console.error : console.log
			const method = target ?? fallback
			;(this as any)[level] = typeof method === 'function' ? method.bind(console) : noop
		}
	}

	private bindNoopLevels() {
		for (const level of LEVELS) {
			;(this as any)[level] = noop
		}
	}
}

// #if NODE_ENV !== 'production'
let rootLogger: Logger | undefined
let rootLoggerLevel: LevelWithSilent | undefined

function getRootLogger(config: ResolvedPinoLoggerConfig): Logger {
	if (!rootLogger) {
		rootLogger = createLogger({ name: config.name, level: config.level })
		rootLoggerLevel = config.level
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

function normalizeLevel(
	level: string | LevelWithSilent | undefined,
	fallback: LevelWithSilent,
): LevelWithSilent {
	if (!level) return fallback
	const normalized = level.toLowerCase() as LevelWithSilent
	return VALID_LEVELS.has(normalized) ? normalized : fallback
}

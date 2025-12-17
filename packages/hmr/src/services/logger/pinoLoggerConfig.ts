import type { LevelWithSilent } from 'pino'

const VALID_LEVELS = new Set<LevelWithSilent>([
	'fatal',
	'error',
	'warn',
	'info',
	'debug',
	'trace',
	'silent',
])

export const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const

export const LEVEL_WEIGHTS: Record<LevelWithSilent, number> = {
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

function normalizeLevel(
	level: string | LevelWithSilent | undefined,
	fallback: LevelWithSilent,
): LevelWithSilent {
	if (!level) return fallback
	const normalized = level.toLowerCase() as LevelWithSilent
	return VALID_LEVELS.has(normalized) ? normalized : fallback
}

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			logger?: PinoLoggerConfig
		}
	}
}

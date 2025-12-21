import { normalizePath, searchForWorkspaceRoot } from 'vite'
import type { LevelWithSilent } from 'pino'

export type LoggerCallerConfig = {
	enabled: boolean
	relativeTo?: string
	stackLimit?: number
	skipCompiled: boolean
	compiledHints: string[]
}

export type LoggerPrettyErrorsConfig = {
	enabled: boolean
	skipCompiled: boolean
	compiledHints: string[]
	hideInternal: boolean
	internalPatterns: string[]
	keepInternalFrames: number
}

export type LoggerPrettyConfig = {
	enabled: boolean
	duplex: boolean
	caller: LoggerCallerConfig
	errors: LoggerPrettyErrorsConfig
}

export type LoggerStoreConfig = {
	enabled: boolean
	minLevel: LevelWithSilent
}

export type LoggerDumperConfig = {
	depth: number
	collectionLimit: number
	typedArrayLimit: number
	bufferPreview: number
	stringLimit: number
}

export type ResolvedLoggerRuntimeConfig = {
	pretty: LoggerPrettyConfig
	store: LoggerStoreConfig
	dumper: LoggerDumperConfig
}

export type LoggerRuntimeConfig = {
	pretty?: {
		enabled?: boolean
		duplex?: boolean
		caller?: Partial<LoggerCallerConfig>
		errors?: Partial<LoggerPrettyErrorsConfig>
	}
	store?: Partial<LoggerStoreConfig>
	dumper?: Partial<LoggerDumperConfig>
}

const VALID_LEVELS = new Set<LevelWithSilent>([
	'fatal',
	'error',
	'warn',
	'info',
	'debug',
	'trace',
	'silent',
])

const DEFAULT_PRETTY_ENABLED = process.env.NODE_ENV !== 'production'
const DEFAULT_COMPILED_HINTS = ['dist', 'build', 'lib']
const DEFAULT_INTERNAL_PATTERNS = ['@pluxel/']
const DEFAULT_DUMPER_CONFIG: LoggerDumperConfig = {
	depth: 4,
	collectionLimit: 50,
	typedArrayLimit: 64,
	bufferPreview: 64,
	stringLimit: 4000,
}

let cachedConfig: ResolvedLoggerRuntimeConfig | undefined
let cachedCallerRoot: string | undefined

const parseBool = (value: string | undefined): boolean | undefined => {
	if (value === undefined) return undefined
	return value !== '0'
}

const parsePositiveInt = (value: string | undefined, fallback: number, min = 0) => {
	const parsed = Number.parseInt(value ?? '', 10)
	if (!Number.isFinite(parsed)) return fallback
	return parsed >= min ? parsed : fallback
}

const parseCsv = (value: string | undefined): string[] | undefined => {
	if (value === undefined) return undefined
	const trimmed = value.trim()
	if (!trimmed) return []
	const items = trimmed
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)
	return items.length ? items : undefined
}

const normalizeLevel = (
	level: string | LevelWithSilent | undefined,
	fallback: LevelWithSilent,
): LevelWithSilent => {
	if (!level) return fallback
	const normalized = level.toLowerCase() as LevelWithSilent
	return VALID_LEVELS.has(normalized) ? normalized : fallback
}

const resolveCallerRoot = () => {
	if (cachedCallerRoot !== undefined) return cachedCallerRoot
	const envRoot = process.env.PLUXEL_LOGGER_CALLER_ROOT?.trim()
	if (envRoot) {
		cachedCallerRoot = normalizePath(envRoot)
		return cachedCallerRoot
	}
	const workspaceRoot = searchForWorkspaceRoot(process.cwd())
	cachedCallerRoot = normalizePath(workspaceRoot || process.cwd())
	return cachedCallerRoot
}

const resolvePrettyEnabled = (overrides: LoggerRuntimeConfig['pretty'] | undefined) => {
	if (overrides?.enabled !== undefined) return overrides.enabled
	const explicit = parseBool(process.env.PLUXEL_LOGGER_PRETTY)
	if (explicit !== undefined) return explicit
	return DEFAULT_PRETTY_ENABLED
}

const resolvePrettyErrorsEnabled = (prettyEnabled: boolean, overrides: LoggerRuntimeConfig | undefined) => {
	const override = overrides?.pretty?.errors?.enabled
	if (override !== undefined) return prettyEnabled && override
	const explicit = parseBool(process.env.PLUXEL_LOGGER_YOUCH)
	if (explicit !== undefined) return prettyEnabled && explicit
	return prettyEnabled
}

const resolveCallerEnabled = (prettyEnabled: boolean, overrides: LoggerRuntimeConfig | undefined) => {
	const override = overrides?.pretty?.caller?.enabled
	if (override !== undefined) return prettyEnabled && override
	const explicit = parseBool(process.env.PLUXEL_LOGGER_CALLER)
	if (explicit !== undefined) return prettyEnabled && explicit
	return prettyEnabled
}

const resolveCompiledHints = (override?: string[]) => {
	if (override !== undefined) return override
	const shared = parseCsv(process.env.PLUXEL_LOGGER_COMPILED_HINTS)
	if (shared !== undefined) return shared
	return DEFAULT_COMPILED_HINTS
}

const resolvePrettyCompiledHints = (overrides: LoggerRuntimeConfig | undefined) => {
	const override = overrides?.pretty?.errors?.compiledHints
	if (override !== undefined) return override
	return resolveCompiledHints()
}

const resolveCallerCompiledHints = (overrides: LoggerRuntimeConfig | undefined) => {
	const override = overrides?.pretty?.caller?.compiledHints
	if (override !== undefined) return override
	return resolvePrettyCompiledHints(overrides)
}

export function resolveLoggerRuntimeConfig(
	overrides: LoggerRuntimeConfig = {},
): ResolvedLoggerRuntimeConfig {
	const prettyEnabled = resolvePrettyEnabled(overrides.pretty)
	const prettyErrorsEnabled = resolvePrettyErrorsEnabled(prettyEnabled, overrides)
	const callerEnabled = resolveCallerEnabled(prettyEnabled, overrides)
	const sharedSkipCompiled = parseBool(process.env.PLUXEL_LOGGER_SKIP_COMPILED)

	const prettyErrorsSkipCompiled =
		overrides.pretty?.errors?.skipCompiled ?? sharedSkipCompiled ?? true
	const callerSkipCompiled =
		overrides.pretty?.caller?.skipCompiled ?? sharedSkipCompiled ?? true

	const hideInternal =
		overrides.pretty?.errors?.hideInternal ??
		parseBool(process.env.PLUXEL_LOGGER_HIDE_INTERNAL) ??
		true
	const internalPatterns =
		overrides.pretty?.errors?.internalPatterns ??
		parseCsv(process.env.PLUXEL_LOGGER_HIDE_INTERNAL_PATTERNS) ??
		DEFAULT_INTERNAL_PATTERNS
	const keepInternalFrames =
		overrides.pretty?.errors?.keepInternalFrames ??
		parsePositiveInt(process.env.PLUXEL_LOGGER_KEEP_INTERNAL_FRAMES, 0, 0)

	const storeEnabled = overrides.store?.enabled ?? (parseBool(process.env.PLUXEL_LOGGER_STORE) ?? true)
	const storeMinLevel = normalizeLevel(
		overrides.store?.minLevel ?? process.env.PLUXEL_LOGGER_STORE_MIN_LEVEL,
		'trace',
	)

	const dumperConfig: LoggerDumperConfig = {
		depth: parsePositiveInt(
			String(overrides.dumper?.depth ?? process.env.PLUXEL_LOGGER_DUMP_DEPTH),
			DEFAULT_DUMPER_CONFIG.depth,
			1,
		),
		collectionLimit: parsePositiveInt(
			String(overrides.dumper?.collectionLimit ?? process.env.PLUXEL_LOGGER_DUMP_COLLECTION_LIMIT),
			DEFAULT_DUMPER_CONFIG.collectionLimit,
			1,
		),
		typedArrayLimit: parsePositiveInt(
			String(overrides.dumper?.typedArrayLimit ?? process.env.PLUXEL_LOGGER_DUMP_TYPED_ARRAY_LIMIT),
			DEFAULT_DUMPER_CONFIG.typedArrayLimit,
			1,
		),
		bufferPreview: parsePositiveInt(
			String(overrides.dumper?.bufferPreview ?? process.env.PLUXEL_LOGGER_DUMP_BUFFER_PREVIEW),
			DEFAULT_DUMPER_CONFIG.bufferPreview,
			4,
		),
		stringLimit: parsePositiveInt(
			String(overrides.dumper?.stringLimit ?? process.env.PLUXEL_LOGGER_DUMP_STRING_LIMIT),
			DEFAULT_DUMPER_CONFIG.stringLimit,
			64,
		),
	}

	const callerRelativeTo = overrides.pretty?.caller?.relativeTo ?? resolveCallerRoot()
	const callerStackLimit =
		overrides.pretty?.caller?.stackLimit ??
		(process.env.PLUXEL_LOGGER_CALLER_STACK_LIMIT
			? parsePositiveInt(process.env.PLUXEL_LOGGER_CALLER_STACK_LIMIT, 20, 1)
			: undefined)

	return {
		pretty: {
			enabled: prettyEnabled,
			duplex: overrides.pretty?.duplex ?? (parseBool(process.env.PLUXEL_LOGGER_PRETTY_DUPLEX) ?? false),
			caller: {
				enabled: prettyEnabled && callerEnabled,
				relativeTo: callerRelativeTo,
				stackLimit: callerStackLimit,
				skipCompiled: callerSkipCompiled,
				compiledHints: resolveCallerCompiledHints(overrides),
			},
			errors: {
				enabled: prettyEnabled && prettyErrorsEnabled,
				skipCompiled: prettyErrorsSkipCompiled,
				compiledHints: resolvePrettyCompiledHints(overrides),
				hideInternal: hideInternal && internalPatterns.length > 0,
				internalPatterns,
				keepInternalFrames,
			},
		},
		store: {
			enabled: storeEnabled,
			minLevel: storeMinLevel,
		},
		dumper: dumperConfig,
	}
}

export function getLoggerRuntimeConfig(
	overrides?: LoggerRuntimeConfig,
): ResolvedLoggerRuntimeConfig {
	if (overrides) return resolveLoggerRuntimeConfig(overrides)
	if (!cachedConfig) cachedConfig = resolveLoggerRuntimeConfig()
	return cachedConfig
}

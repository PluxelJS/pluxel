import { isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProduction } from 'std-env'

export type CallerCaptureOptions = {
	/** Exclude frames up to and including this function (Node/Bun only). */
	exclude?: (...args: never[]) => unknown
	/** Additional skip markers applied on top of defaults. */
	skipMarkers?: readonly string[]
}

function parseBool(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined
	return value !== '0'
}

let cachedCallerEnabled: boolean | undefined

type ProcessLike = {
	env?: Record<string, string | undefined>
	cwd?: () => string
}

function getProcessLike(): ProcessLike | undefined {
	return (globalThis as unknown as { process?: ProcessLike }).process
}

export function isCallerEnabled(): boolean {
	if (cachedCallerEnabled !== undefined) return cachedCallerEnabled

	// Override: explicit env always wins (including in production).
	const explicit =
		parseBool(getProcessLike()?.env?.PLUXEL_LOG_CALLER) ??
		parseBool(getProcessLike()?.env?.PLUXEL_LOGGER_CALLER)
	if (explicit !== undefined) {
		cachedCallerEnabled = explicit
		return explicit
	}

	// Default: enable in dev/test, disable in production.
	cachedCallerEnabled = !isProduction
	return cachedCallerEnabled
}

const DEFAULT_SKIP_MARKERS = [
	'/node_modules/@logtape/',
	'\\node_modules\\@logtape\\',
	'/packages/core/src/logger/',
	'/packages/hmr/src/logger/',
	'/packages/hmr/src/services/hmr/logging.',
	'/packages/core/dist/',
	'/packages/hmr/dist/',
	'/dist/',
	'LoggerService.',
	'LogtapeLoggerService.',
	'/logger/index.',
] as const

function tryFileUrlToPath(input: string): string {
	if (!input.startsWith('file://')) return input
	try {
		return fileURLToPath(input)
	} catch {
		return input
	}
}

function relativizeToCwd(file: string): string {
	const f = tryFileUrlToPath(file)
	if (!isAbsolute(f)) return f
	const cwd = getProcessLike()?.cwd?.()
	if (!cwd) return f
	const rel = relative(cwd, f)
	// Only use relative paths when they stay within cwd (avoid ../.. noise).
	if (!rel || rel.startsWith('..') || rel.startsWith('../') || rel.startsWith('..\\')) return f
	return rel
}

function normalizeFunctionName(fn: string): string {
	return fn
		.replace(/^async\s+/, '')
		.replace(/^Object\./, '')
		.replace(/^Module\./, '')
		.replace(/^Function\./, '')
}

export function captureCaller(opts: CallerCaptureOptions = {}): string | undefined {
	const error = {} as { stack?: string }
	const captureStackTrace = (
		Error as unknown as {
			captureStackTrace?: (
				targetObject: object,
				constructorOpt?: CallerCaptureOptions['exclude'],
			) => void
		}
	).captureStackTrace
	if (typeof captureStackTrace === 'function') {
		captureStackTrace(error, opts.exclude ?? captureCaller)
	} else {
		error.stack = new Error().stack
	}
	const stack = error.stack
	if (!stack) return undefined

	const skipMarkers = opts.skipMarkers?.length
		? [...DEFAULT_SKIP_MARKERS, ...opts.skipMarkers]
		: DEFAULT_SKIP_MARKERS
	const lines = stack.split('\n').slice(1)
	for (const raw of lines) {
		const line = raw.trim()
		if (!line.startsWith('at ')) continue
		if (skipMarkers.some((m) => line.includes(m))) continue

		// Node/Bun: "at fn (file:line:col)" or "at file:line:col"
		const m =
			line.match(/^at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)$/) ?? line.match(/^at\s+(.*?):(\d+):(\d+)$/)
		if (!m) continue

		if (m.length === 5) {
			const [, fn, file, l, c] = m
			return `${normalizeFunctionName(fn)} (${relativizeToCwd(file)}:${l}:${c})`
		}
		if (m.length === 4) {
			const [, file, l, c] = m
			return `${relativizeToCwd(file)}:${l}:${c}`
		}
	}

	return undefined
}

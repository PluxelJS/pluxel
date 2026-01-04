import { relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export type CallerCaptureOptions = {
	/** Exclude frames up to and including this function (Node/Bun only). */
	exclude?: Function
	/** Additional skip markers applied on top of defaults. */
	skipMarkers?: readonly string[]
}

function parseBool(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined
	return value !== '0'
}

export function isCallerEnabled(): boolean {
	return (
		parseBool(process.env.PLUXEL_LOG_CALLER) ??
		parseBool(process.env.PLUXEL_LOGGER_CALLER) ??
		true
	)
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
	const cwd = (globalThis as any).process?.cwd?.() as string | undefined
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
	if (typeof Error.captureStackTrace === 'function') {
		Error.captureStackTrace(error, opts.exclude ?? captureCaller)
	} else {
		error.stack = new Error().stack
	}
	const stack = error.stack
	if (!stack) return undefined

	const skipMarkers =
		opts.skipMarkers && opts.skipMarkers.length
			? [...DEFAULT_SKIP_MARKERS, ...opts.skipMarkers]
			: DEFAULT_SKIP_MARKERS
	const lines = stack.split('\n').slice(1)
	for (const raw of lines) {
		const line = raw.trim()
		if (!line.startsWith('at ')) continue
		if (skipMarkers.some((m) => line.includes(m))) continue

		// Node/Bun: "at fn (file:line:col)" or "at file:line:col"
		const m =
			line.match(/^at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)$/) ??
			line.match(/^at\s+(.*?):(\d+):(\d+)$/)
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

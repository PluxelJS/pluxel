import { isAbsolute, relative } from 'pathe'
import { isProduction } from 'std-env'

import { readBoolEnv, tryGetCwd } from './runtime'

export type CallerCaptureOptions = {
	/** Additional skip markers applied on top of defaults. */
	skipMarkers?: readonly string[]
}

let cachedCallerEnabled: boolean | undefined

export function isCallerEnabled(): boolean {
	if (cachedCallerEnabled !== undefined) return cachedCallerEnabled

	// Override: explicit env always wins (including in production).
	const explicit = readBoolEnv('PLUXEL_LOG_CALLER') ?? readBoolEnv('PLUXEL_LOGGER_CALLER')
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
	'/packages/core/src/test.',
	'\\packages\\core\\src\\test.',
	'/packages/runtime/src/logger/',
	'/packages/runtime-dynamic/src/hmr/hmr/logging.',
	'/packages/core/dist/',
	'/packages/runtime/dist/',
	'/packages/runtime-dynamic/dist/',
	'/dist/',
	'LoggerService.log',
	'LoggerService.levelMethod',
	'/logger/index.',
] as const

function tryFileUrlToPath(input: string): string {
	if (!input.startsWith('file://')) return input
	try {
		const url = new URL(input)
		if (url.protocol !== 'file:') return input

		let path = decodeURIComponent(url.pathname)
		// Windows drive letters: file:///C:/path -> C:/path
		if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
		// UNC paths: file://server/share/path -> //server/share/path
		if (url.hostname) path = `//${url.hostname}${path}`

		return path
	} catch {
		return input
	}
}

function relativizeToCwd(file: string): string {
	const f = tryFileUrlToPath(file)
	if (!isAbsolute(f)) return f
	const cwd = tryGetCwd()
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
	const stack = new Error('captureCaller stack').stack
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

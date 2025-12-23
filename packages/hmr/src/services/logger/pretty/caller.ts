import path from 'node:path'
import type { LoggerOptions } from 'pino'
import type { LoggerCallerConfig } from '../loggerRuntimeConfig'
import {
	createCompiledPathMatcher,
	extractStackFile,
	normalizeFileName,
	normalizePath,
	type CompiledPathMatcher,
} from './stack'

const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const DEFAULT_STACK_LIMIT = Number.isFinite(Error.stackTraceLimit)
	? (Error.stackTraceLimit as number)
	: 10
const CALLER_STACK_LIMIT_BASE = clampNumber(DEFAULT_STACK_LIMIT, 6, 16)
const CALLER_STACK_LIMIT_FALLBACK = clampNumber(CALLER_STACK_LIMIT_BASE * 2, 12, 32)
let callerStackLimit = CALLER_STACK_LIMIT_BASE

const LOGGER_DIR = path.dirname(normalizeFileName(import.meta.url)).replace(/\\/g, '/').concat('/')
// When packages are bundled (e.g. `dist/services.mjs`), `LOGGER_DIR` might not contain the original
// directory structure, but sourcemapped stacks still point to `.../services/logger/...`.
// Keep these stable markers so we can reliably skip internal logger frames in both source and dist.
const LOGGER_INTERNAL_MARKERS = ['/services/logger/pretty/caller.', '/services/logger/pretty/', '/services/logger/']
const LOGGER_DIR_TOKENS = (() => {
	const tokens = new Set<string>([LOGGER_DIR, ...LOGGER_INTERNAL_MARKERS])
	const marker = '/services/logger/'
	const markerIndex = LOGGER_DIR.lastIndexOf(marker)
	if (markerIndex !== -1) {
		tokens.add(LOGGER_DIR.slice(markerIndex))
		tokens.add(marker)
	}
	return [...tokens].filter(Boolean)
})()

const CALLER_SKIP_PATTERNS = [
	'/node_modules/pino/',
	'\\node_modules\\pino\\',
	'/node_modules/pino-pretty/',
	'\\node_modules\\pino-pretty\\',
]
const CALLER_SKIP_TOKENS = CALLER_SKIP_PATTERNS.map(normalizePath)
const CALLER_SKIP_PREFIXES = ['node:', 'internal:', LOGGER_DIR]
const CALLER_SKIP_INCLUDES = ['evalmachine.<anonymous>', ...LOGGER_DIR_TOKENS, ...CALLER_SKIP_TOKENS]
const STACK_SKIP_TOKENS = [
	'node:',
	'internal/',
	'evalmachine.<anonymous>',
	...LOGGER_DIR_TOKENS,
	...CALLER_SKIP_TOKENS,
]

const matchesAnyPrefix = (value: string, prefixes: string[]) =>
	prefixes.some((prefix) => value.startsWith(prefix))

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const buildIncludesRegex = (tokens: string[]) => {
	const pattern = tokens.map(escapeRegExp).filter(Boolean).join('|')
	return pattern ? new RegExp(pattern) : null
}
const CALLER_SKIP_RE = buildIncludesRegex(CALLER_SKIP_INCLUDES)
const STACK_SKIP_RE = buildIncludesRegex(STACK_SKIP_TOKENS)
const matchesIncludes = (value: string, re: RegExp | null) => (re ? re.test(value) : false)

type CallerRuntime = LoggerCallerConfig & {
	compiledMatcher: CompiledPathMatcher
}

function stripRelativeTo(fileName: string, relativeTo?: string): string {
	if (!relativeTo) return fileName
	const file = normalizeFileName(fileName)
	const base = normalizePath(relativeTo)
	const baseWithSlash = base.endsWith('/') ? base : `${base}/`
	return file.startsWith(baseWithSlash) ? file.slice(baseWithSlash.length) : file
}

function shouldSkipFrame(fileName: string, runtime: CallerRuntime): boolean {
	const normalized = normalizeFileName(fileName)
	if (matchesAnyPrefix(normalized, CALLER_SKIP_PREFIXES)) return true
	if (runtime.skipCompiled && runtime.compiledMatcher.isCompiledPath(normalized)) return true
	return matchesIncludes(normalized, CALLER_SKIP_RE)
}

function getCallSiteFileName(callSite: NodeJS.CallSite): string | undefined {
	const fileName = callSite.getFileName?.()
	if (fileName) return fileName
	const scriptName = (callSite as any).getScriptNameOrSourceURL?.()
	return scriptName || undefined
}

function shouldSkipStackLine(line: string, runtime: CallerRuntime): boolean {
	const normalized = normalizePath(line)
	if (matchesIncludes(normalized, STACK_SKIP_RE)) return true
	if (!runtime.skipCompiled) return false
	const file = extractStackFile(line)
	if (!file) return false
	return runtime.compiledMatcher.isCompiledPath(file)
}

function getCallerFromCallSites(runtime: CallerRuntime, limit: number): string | undefined {
	const originalPrepare = Error.prepareStackTrace
	const originalLimit = Error.stackTraceLimit
	try {
		// Keep stack capture small; we only need a few frames.
		Error.stackTraceLimit = limit
		Error.prepareStackTrace = (_err, stack) => stack as unknown as string
		const err = new Error()
		Error.captureStackTrace(err, getCallerFromCallSites)
		const stack = err.stack as unknown as NodeJS.CallSite[] | undefined
		if (Array.isArray(stack)) {
			let picked: NodeJS.CallSite | undefined
			for (const callSite of stack) {
				const fileName = getCallSiteFileName(callSite)
				if (!fileName) continue
				if (shouldSkipFrame(fileName, runtime)) continue
				picked = callSite
				break
			}
			if (!picked) return undefined
			const fileName = getCallSiteFileName(picked)
			if (!fileName) return undefined
			const line = picked.getLineNumber?.() ?? 0
			const col = picked.getColumnNumber?.() ?? 0
			const fn =
				picked.getMethodName?.() ??
				picked.getFunctionName?.() ??
				picked.getTypeName?.() ??
				undefined

			const loc = `${stripRelativeTo(fileName, runtime.relativeTo)}:${line}:${col}`
			return fn ? `${fn} (${loc})` : loc
		}
	} catch {
		// fallthrough to string parsing
	} finally {
		Error.prepareStackTrace = originalPrepare
		Error.stackTraceLimit = originalLimit
	}
	return undefined
}

function getCaller(runtime: CallerRuntime): string | undefined {
	const preferStackString = typeof Error.prepareStackTrace === 'function'
	if (preferStackString) {
		const caller = getCallerFromStackString(runtime)
		if (caller) return caller
	}

	const firstLimit = runtime.stackLimit ?? callerStackLimit
	let caller = getCallerFromCallSites(runtime, firstLimit)
	if (
		!caller &&
		runtime.stackLimit === undefined &&
		firstLimit < CALLER_STACK_LIMIT_FALLBACK
	) {
		caller = getCallerFromCallSites(runtime, CALLER_STACK_LIMIT_FALLBACK)
		if (caller) callerStackLimit = CALLER_STACK_LIMIT_FALLBACK
	}
	if (caller) return caller

	if (preferStackString) return undefined
	return getCallerFromStackString(runtime)
}

function getCallerFromStackString(runtime: CallerRuntime): string | undefined {
	try {
		const err = new Error()
		Error.captureStackTrace?.(err, getCallerFromStackString)
		const raw = String(err.stack ?? '')
		const lines = raw.split('\n').slice(1)
		const filtered = lines.filter((line) => {
			const l = line.trim()
			if (!l) return false
			return !shouldSkipStackLine(l, runtime)
		})

		const picked = filtered[0]
		if (!picked) return undefined
		const withoutAt = picked.trim().replace(/^at\s+/, '')
		if (withoutAt.endsWith(')')) {
			const openParen = withoutAt.indexOf('(')
			if (openParen !== -1) {
				const name = withoutAt.slice(0, openParen).trim()
				let locRaw = withoutAt.slice(openParen + 1, -1)
				const nestedOpen = locRaw.lastIndexOf('(')
				const nestedClose = locRaw.lastIndexOf(')')
				if (nestedOpen !== -1 && nestedClose !== -1 && nestedClose > nestedOpen) {
					locRaw = locRaw.slice(nestedOpen + 1, nestedClose)
				} else if (locRaw.endsWith(')')) {
					locRaw = locRaw.slice(0, -1)
				}
				const loc = stripRelativeTo(locRaw, runtime.relativeTo)
				return name ? `${name} (${loc})` : loc
			}
		}
		return stripRelativeTo(withoutAt, runtime.relativeTo)
	} catch {
		return undefined
	}
}

export function withCallerFormatters(
	base: LoggerOptions['formatters'] | undefined,
	config: LoggerCallerConfig,
): LoggerOptions['formatters'] {
	if (!config.enabled) return base
	const runtime: CallerRuntime = {
		...config,
		compiledMatcher: createCompiledPathMatcher(config.compiledHints),
	}
	const baseLogFormatter = base?.log
	return {
		...base,
		log(obj) {
			const out = (baseLogFormatter ? baseLogFormatter(obj) : obj) as Record<string, unknown>
			if (out && typeof out === 'object' && out.caller === undefined) {
				const caller = getCaller(runtime)
				if (caller) out.caller = caller
			}
			return out
		},
	}
}

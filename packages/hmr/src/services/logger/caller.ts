import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LoggerOptions } from 'pino'

export type CallerOptions = {
	relativeTo?: string
	stackAdjustment?: number
}

const CALLER_ENABLED = (process.env.PLUXEL_LOGGER_CALLER ?? '1') !== '0'

const LOGGER_DIR = path
	.dirname(fileURLToPath(import.meta.url))
	.replaceAll('\\', '/')
	.concat('/')

const CALLER_SKIP_PATTERNS = [
	'/node_modules/pino/',
	'\\node_modules\\pino\\',
	'/node_modules/pino-pretty/',
	'\\node_modules\\pino-pretty\\',
]

function toPathIfFileUrl(fileName: string): string {
	if (fileName.startsWith('file://')) {
		try {
			return fileURLToPath(fileName)
		} catch {
			// fallthrough
		}
	}
	return fileName
}

function stripRelativeTo(fileName: string, relativeTo?: string): string {
	if (!relativeTo) return fileName
	const file = toPathIfFileUrl(fileName).replaceAll('\\', '/')
	const base = relativeTo.replaceAll('\\', '/')
	const baseWithSlash = base.endsWith('/') ? base : `${base}/`
	return file.startsWith(baseWithSlash) ? file.slice(baseWithSlash.length) : file
}

function shouldSkipFrame(fileName: string): boolean {
	const normalized = toPathIfFileUrl(fileName).replaceAll('\\', '/')
	if (normalized.startsWith('node:')) return true
	if (normalized.startsWith('internal:')) return true
	if (normalized.startsWith(LOGGER_DIR)) return true
	for (const pattern of CALLER_SKIP_PATTERNS) {
		if (normalized.includes(pattern)) return true
	}
	return false
}

function getCaller(options: CallerOptions): string | undefined {
	const stackAdjustment = options.stackAdjustment ?? 0

	const originalPrepare = Error.prepareStackTrace
	const originalLimit = Error.stackTraceLimit
	try {
		// Keep stack capture small; we only need a few frames.
		Error.stackTraceLimit = Math.max(8, stackAdjustment + 8)
		Error.prepareStackTrace = (_err, stack) => stack as unknown as string
		const err = new Error()
		Error.captureStackTrace(err, getCaller)
		const stack = err.stack as unknown as NodeJS.CallSite[] | undefined
		if (Array.isArray(stack)) {
			let picked: NodeJS.CallSite | undefined
			let seen = 0
			for (const callSite of stack) {
				const fileName = callSite.getFileName?.()
				if (!fileName) continue
				if (shouldSkipFrame(fileName)) continue
				if (seen < stackAdjustment) {
					seen++
					continue
				}
				picked = callSite
				break
			}

			if (!picked) return undefined
			const fileName = picked.getFileName?.()
			if (!fileName) return undefined
			const line = picked.getLineNumber?.() ?? 0
			const col = picked.getColumnNumber?.() ?? 0
			const fn =
				picked.getMethodName?.() ??
				picked.getFunctionName?.() ??
				picked.getTypeName?.() ??
				undefined

			const loc = `${stripRelativeTo(fileName, options.relativeTo)}:${line}:${col}`
			return fn ? `${fn} (${loc})` : loc
		}
	} catch {
		// fallthrough to string parsing
	} finally {
		Error.prepareStackTrace = originalPrepare
		Error.stackTraceLimit = originalLimit
	}

	try {
		const raw = String(new Error().stack ?? '')
		const lines = raw.split('\n').slice(1)
		const filtered = lines.filter((line) => {
			const l = line.trim()
			if (!l) return false
			if (l.includes('node:')) return false
			if (l.includes('internal/')) return false
			if (l.includes('internal\\')) return false
			const normalized = l.replaceAll('\\', '/')
			if (normalized.includes(LOGGER_DIR)) return false
			for (const pattern of CALLER_SKIP_PATTERNS) {
				if (normalized.includes(pattern)) return false
			}
			return true
		})

		const picked = filtered[stackAdjustment]
		if (!picked) return undefined
		const withoutAt = picked.trim().replace(/^at\\s+/, '')
		const match = withoutAt.match(/\\((.*)\\)$/)
		if (match?.[1]) {
			const openParen = withoutAt.indexOf('(')
			const name = openParen > 0 ? withoutAt.slice(0, openParen).trim() : ''
			const loc = stripRelativeTo(match[1], options.relativeTo)
			return name ? `${name} (${loc})` : loc
		}
		return stripRelativeTo(withoutAt, options.relativeTo)
	} catch {
		return undefined
	}
}

export function withCallerFormatters(
	base: LoggerOptions['formatters'] | undefined,
	options: CallerOptions,
): LoggerOptions['formatters'] {
	if (!CALLER_ENABLED) return base
	const baseLogFormatter = base?.log
	return {
		...base,
		log(obj) {
			const out = (baseLogFormatter ? baseLogFormatter(obj) : obj) as Record<string, unknown>
			if (out && typeof out === 'object' && out.caller === undefined) {
				const caller = getCaller(options)
				if (caller) out.caller = caller
			}
			return out
		},
	}
}

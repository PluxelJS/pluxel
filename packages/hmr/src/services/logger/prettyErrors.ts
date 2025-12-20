import type { Bindings, Logger } from 'pino'
import type { ParsedError } from 'youch/types'

const PRETTY_ERRORS_ENABLED =
	process.env.NODE_ENV !== 'production' &&
	(process.env.PLUXEL_LOGGER_PRETTY ?? process.env.PLUXEL_YOUCH ?? '1') !== '0'
const PRETTY_SKIP_COMPILED = (process.env.PLUXEL_LOGGER_PRETTY_SKIP_COMPILED ?? '1') !== '0'
const COMPILED_PATH_HINTS = (process.env.PLUXEL_LOGGER_PRETTY_COMPILED_HINTS ?? 'dist,build,lib')
	.split(',')
	.map((item) => item.trim())
	.filter(Boolean)
const COMPILED_EXTS = new Set(['.js', '.mjs', '.cjs'])

const DEFAULT_INTERNAL_PATTERNS = ['@pluxel/']
const INTERNAL_PATTERN_ENV =
	process.env.PLUXEL_LOGGER_HIDE_INTERNAL_PATTERNS ?? DEFAULT_INTERNAL_PATTERNS.join(',')
const INTERNAL_FRAME_PATTERNS = INTERNAL_PATTERN_ENV.split(',')
	.map((item) => item.trim())
	.filter(Boolean)

const HIDE_INTERNAL_FRAMES =
	(process.env.PLUXEL_LOGGER_HIDE_INTERNAL ?? '1') !== '0' && INTERNAL_FRAME_PATTERNS.length > 0
const KEEP_INTERNAL_FRAMES = Math.max(
	0,
	Number.parseInt(process.env.PLUXEL_LOGGER_KEEP_INTERNAL_FRAMES ?? '0', 10) || 0,
)
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const globToRegExp = (pattern: string) => {
	const escaped = escapeRegExp(pattern)
	const globReady = escaped.replace(/\\\*/g, '.*')
	return new RegExp(globReady, 'i')
}

const INTERNAL_FRAME_RES = INTERNAL_FRAME_PATTERNS.map(globToRegExp)

const PRETTY_PATCHED = Symbol('pluxel.logger.pretty_patched')
const PRETTY_CONTEXT = Symbol('pluxel.logger.pretty_context')

const seenErrors = new WeakSet<Error>()
let renderQueue: Promise<void> = Promise.resolve()

type YouchModule = typeof import('youch')
type YouchInstance = InstanceType<YouchModule['Youch']>
let youchModulePromise: Promise<YouchModule> | undefined
let youchInstance: YouchInstance | undefined
let youchConfigured = false

export interface PrettyErrorPayload {
	scope?: string
	error: Error
	ansi: string
	plain: string
}

export type PrettyErrorSink = (payload: PrettyErrorPayload) => void

const ANSI_ESCAPE_RE =
	/[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g
const stripAnsi = (value: string) => value.replace(ANSI_ESCAPE_RE, '')

export const writePrettyErrorToStderr: PrettyErrorSink = ({ ansi }) => {
	const body = ansi.endsWith('\n') ? ansi : `${ansi}\n`
	process.stderr.write(body.startsWith('\n') ? body : `\n${body}`)
}

interface PrettyContext {
	scope?: string
	sinks: PrettyErrorSink[]
}

const defaultSinks: PrettyErrorSink[] = [writePrettyErrorToStderr]

const ensureContext = (logger: Logger, ctx: PrettyContext) => {
	const existing = (logger as any)[PRETTY_CONTEXT] as PrettyContext | undefined
	if (existing) {
		if (ctx.scope !== undefined) existing.scope = ctx.scope
		if (ctx.sinks.length) existing.sinks = ctx.sinks
		return existing
	}
	const next: PrettyContext = {
		sinks: ctx.sinks,
	}
	if (ctx.scope !== undefined) next.scope = ctx.scope
	;(logger as any)[PRETTY_CONTEXT] = next
	return next
}

const getContext = (logger: Logger): PrettyContext | undefined => (logger as any)[PRETTY_CONTEXT]

export interface PrettyErrorOptions {
	scope?: string
	sinks?: PrettyErrorSink[]
}

export function attachPrettyErrors<T extends Logger>(
	logger: T,
	options: PrettyErrorOptions = {},
): T {
	if (!PRETTY_ERRORS_ENABLED) return logger

	const sinks = options.sinks && options.sinks.length ? options.sinks : defaultSinks
	const context: PrettyContext = { sinks }
	if (options.scope !== undefined) context.scope = options.scope
	ensureContext(logger, context)

	if ((logger as any)[PRETTY_PATCHED]) return logger
	;(logger as any)[PRETTY_PATCHED] = true

	for (const level of ['error', 'fatal'] as const) {
		const original = logger[level] as (...args: unknown[]) => unknown
		logger[level] = function patched(this: Logger, ...args: unknown[]) {
			const nextArgs = maybeRenderPrettyError(this, args)
			return original.apply(this, nextArgs as any)
		} as Logger[typeof level]
	}

	const originalChild = logger.child
	logger.child = function child(this: Logger, bindings?: Bindings, options?: any) {
		const childLogger = originalChild.apply(this, arguments as any)
		const parentCtx = getContext(this)
		const scope = extractScope(bindings) ?? parentCtx?.scope ?? bindings?.name
		const sinksOverride = parentCtx?.sinks ?? defaultSinks
		const childOptions: PrettyErrorOptions = { sinks: sinksOverride }
		if (scope !== undefined) childOptions.scope = scope
		return attachPrettyErrors(childLogger as unknown as T, childOptions)
	} as typeof logger.child

	return logger
}

function extractScope(bindings?: Bindings): string | undefined {
	if (!bindings) return undefined
	if (typeof bindings.name === 'string' && bindings.name) return bindings.name
	if (typeof (bindings as any).scope === 'string') return (bindings as any).scope
	if (typeof (bindings as any).pluginId === 'string') return (bindings as any).pluginId
	return undefined
}

function maybeRenderPrettyError(logger: Logger, args: readonly unknown[]) {
	if (!PRETTY_ERRORS_ENABLED) return args
	const ctx = getContext(logger)
	if (!ctx) return args
	const err = extractError(args)
	if (!err || seenErrors.has(err)) return args
	if (PRETTY_SKIP_COMPILED && shouldSkipPrettyError(err)) return args
	seenErrors.add(err)
	renderQueue = renderQueue
		.then(() => renderYouch(err, ctx))
		.catch((error) => {
			// eslint-disable-next-line no-console
			console.error('[logger] failed to render pretty error', error)
		})
	return sanitizeErrorArgs(args)
}

function extractError(args: readonly unknown[]): Error | undefined {
	for (const arg of args) {
		if (arg instanceof Error) return arg
		if (arg && typeof arg === 'object') {
			const payload = arg as Record<string, unknown>
			if (payload.err instanceof Error) return payload.err
			if (payload.error instanceof Error) return payload.error
			if (payload.cause instanceof Error) return payload.cause
		}
	}
	return undefined
}

async function renderYouch(error: Error, ctx: PrettyContext) {
	const reporter = await ensureYouch()
	const output = await reporter.toANSI(error)
	const ansi = output.endsWith('\n') ? output : `${output}\n`
	const payload: PrettyErrorPayload = {
		error,
		ansi,
		plain: stripAnsi(ansi),
	}
	if (ctx.scope !== undefined) {
		payload.scope = ctx.scope
	}
	for (const sink of ctx.sinks) {
		try {
			sink(payload)
		} catch (sinkError) {
			// eslint-disable-next-line no-console
			console.error('[logger] pretty error sink failed', sinkError)
		}
	}
}

function shouldSkipPrettyError(error: Error): boolean {
	const stack = error.stack
	if (!stack) return false
	const lines = stack.split('\n').slice(1)
	let hasSourceFrame = false
	let hasCompiledFrame = false
	for (const line of lines) {
		const file = extractStackFile(line)
		if (!file) continue
		const normalized = file.replaceAll('\\', '/')
		if (normalized.startsWith('node:')) continue
		if (normalized.includes('/node_modules/')) continue
		if (isInternalPath(normalized)) continue
		const candidate = normalized.replace(/:\d+(?::\d+)?$/, '')
		const ext = candidate.slice(candidate.lastIndexOf('.')).toLowerCase()
		if (!COMPILED_EXTS.has(ext)) {
			hasSourceFrame = true
			continue
		}
		if (COMPILED_PATH_HINTS.length === 0) {
			hasCompiledFrame = true
			continue
		}
		for (const hint of COMPILED_PATH_HINTS) {
			const token = hint.startsWith('/') ? hint : `/${hint}/`
			if (candidate.includes(token)) {
				hasCompiledFrame = true
				break
			}
		}
	}
	if (hasSourceFrame) return false
	return hasCompiledFrame
}

function extractStackFile(line: string): string | undefined {
	const trimmed = line.trim()
	if (!trimmed.startsWith('at ')) return undefined
	const match = trimmed.match(/\((.*)\)$/)
	if (match?.[1]) return match[1]
	const parts = trimmed.replace(/^at\s+/, '')
	return parts.includes(':') ? parts : undefined
}

function isInternalPath(fileName: string): boolean {
	return INTERNAL_FRAME_RES.some((regex) => regex.test(fileName))
}

async function ensureYouch(): Promise<YouchInstance> {
	if (!youchModulePromise) {
		youchModulePromise = import('youch') as Promise<YouchModule>
	}
	const mod = await youchModulePromise
	if (!youchInstance) youchInstance = new mod.Youch()
	if (!youchConfigured) {
		configureYouch(youchInstance)
		youchConfigured = true
	}
	return youchInstance
}

function configureYouch(instance: YouchInstance) {
	if (!HIDE_INTERNAL_FRAMES) return
	instance.useTransformer((parsedError: ParsedError) => {
		if (!Array.isArray(parsedError.frames)) return
		const filtered: typeof parsedError.frames = []
		let keptInternal = 0
		for (const frame of parsedError.frames) {
			if (isInternalFrame(frame)) {
				if (keptInternal < KEEP_INTERNAL_FRAMES) {
					keptInternal++
					filtered.push(frame)
				}
				continue
			}
			filtered.push(frame)
		}
		if (filtered.length === 0) {
			const fallbackCount = Math.max(1, KEEP_INTERNAL_FRAMES || 1)
			parsedError.frames = parsedError.frames.slice(0, fallbackCount)
		} else {
			parsedError.frames = filtered
		}
	})
}

type ParsedFrame = ParsedError['frames'][number]

function isInternalFrame(frame: ParsedFrame) {
	if (!frame) return false
	const fileName = frame.fileName
	if (typeof fileName !== 'string') return false
	return INTERNAL_FRAME_RES.some((regex) => regex.test(fileName))
}

const ERROR_PAYLOAD_KEYS = ['err', 'error', 'cause'] as const

function sanitizeErrorArgs(args: readonly unknown[]): readonly unknown[] {
	let mutated = false
	const next = args.map((value) => {
		const sanitized = sanitizeErrorValue(value)
		if (sanitized !== value) mutated = true
		return sanitized
	})
	return mutated ? next : args
}

function sanitizeErrorValue(value: unknown): unknown {
	if (value instanceof Error) return summarizeError(value)
	if (Array.isArray(value)) {
		let clone: unknown[] | undefined
		value.forEach((item, index) => {
			const sanitized = sanitizeErrorValue(item)
			if (sanitized !== item) {
				if (!clone) clone = [...value]
				clone[index] = sanitized
			}
		})
		return clone ?? value
	}
	if (value && typeof value === 'object') {
		let clone: Record<string, unknown> | undefined
		for (const key of ERROR_PAYLOAD_KEYS) {
			const current = (value as Record<string, unknown>)[key]
			const sanitized = sanitizeErrorValue(current)
			if (sanitized !== current) {
				if (!clone) clone = { ...(value as Record<string, unknown>) }
				clone[key] = sanitized
			}
		}
		return clone ?? value
	}
	return value
}

function summarizeError(err: Error): Record<string, unknown> {
	const summary: Record<string, unknown> = {
		name: err.name,
		message: err.message,
		prettyErrorHandled: true,
	}
	const errRecord = err as unknown as Record<string, unknown>
	for (const key of Object.keys(errRecord)) {
		if (key === 'stack') continue
		summary[key] = sanitizeErrorValue(errRecord[key])
	}
	const cause = (err as any).cause
	if (cause !== undefined && !('cause' in summary)) {
		summary.cause = cause instanceof Error ? summarizeError(cause) : sanitizeErrorValue(cause)
	}
	return summary
}

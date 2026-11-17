import { parsePluginNodeAddress, type PluginNodeAddress } from '@pluxel/core'
import {
	DetachedPluginNodeAddressError,
	readPluginNodeAddressEvidence,
} from '@pluxel/core/internal/plugin-address-evidence'
import { ScriptError, type ScriptErrorDetails } from './sdk-outcomes'

/** Script control and artifact versions are independent from application/Plugin ABI. */
export const SCRIPT_PROTOCOL = 4 as const
export const SCRIPT_ARTIFACT_FORMAT = 'pluxel-js-factory/5' as const
export const SCRIPT_VALUE_BYTES = 1024 * 1024
export const SCRIPT_DEFAULT_TIMEOUT = 30_000
export const SCRIPT_MAX_TIMEOUT = 300_000

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue }
export type ScriptProjectCode = Readonly<{
	kind: 'project'
	file: string
	sourceHash: string
	exportName: string
}>
/**
 * Function body returning module exports. Format 5 receives three parameters:
 * `__pluxel_script_better_result`, `__pluxel_script_control` and `__pluxel_script_host`,
 * bound to the receiver's Better Result, control-reference and public Host SDK namespaces.
 * Ordinary computation dependencies are
 * bundled into the body; the source map describes this body without a wrapper prefix.
 */
export type ScriptArtifact = Readonly<{
	kind: 'artifact'
	format: typeof SCRIPT_ARTIFACT_FORMAT
	code: string
	sourceHash: string
	exportName: string
	/** Version 3 source map JSON, generated together with code by the compiler. */
	sourceMap?: string
}>
export type ScriptCode = ScriptProjectCode | ScriptArtifact
export type ScriptSubmission = Readonly<{
	runId: string
	code: ScriptCode
	input?: JsonValue
	/** Includes queueing, loading and cooperative execution. @defaultValue 30000 */
	timeoutMs?: number
}>
export type ScriptHmrAction = 'pause' | 'apply' | 'resume'
export type ScriptControlSubmission = Readonly<{
	runId: string
	action: ScriptHmrAction
	timeoutMs?: number
}>
export type ScriptPhase = 'admission' | 'load' | 'execute' | 'encode' | 'cleanup'
/** Native TypeScript diagnostic; source positions are one-based UTF-16 coordinates. */
export type ScriptDiagnostic = Readonly<{
	file?: string
	line?: number
	column?: number
	code: number
	message: string
}>
export type ScriptFailure = Readonly<{
	code: string
	message: string
	/** Expected SDK failure facts, including persistence state and complete domain reports. */
	details?: ScriptErrorDetails
	stack?: string
	hint?: string
	context?: JsonValue
	diagnostics?: readonly ScriptDiagnostic[]
}>
type ScriptMetadata = Readonly<{
	runId: string
	instanceId: string
	requestHash: string
	submittedAt: string
	startedAt?: string
	hostEpoch?: string
	revisions?: Readonly<{ before?: JsonValue; after?: JsonValue }>
	cleanupError?: ScriptFailure
}> &
	(
		| Readonly<{
				kind: 'script'
				code: ScriptProjectCode | Omit<ScriptArtifact, 'code' | 'sourceMap'>
		  }>
		| Readonly<{ kind: 'hmr'; action: ScriptHmrAction }>
	)
export type ScriptRunSnapshot = ScriptMetadata &
	(
		| Readonly<{
				state: 'queued' | 'preparing' | 'running' | 'cancelling'
				phase: ScriptPhase
				cancelReason?: string
		  }>
		| Readonly<{ state: 'succeeded'; finishedAt: string; value: JsonValue }>
		| Readonly<{
				state: 'failed' | 'cancelled'
				finishedAt: string
				phase: ScriptPhase
				error: ScriptFailure
				executionError?: ScriptFailure
		  }>
	)

export class ScriptExecutionError extends Error {
	readonly details?: ScriptErrorDetails
	readonly hint?: string
	readonly context?: JsonValue
	readonly diagnostics?: readonly ScriptDiagnostic[]

	constructor(
		readonly code: string,
		message: string,
		options: Pick<ScriptFailure, 'details' | 'hint' | 'context' | 'diagnostics'> = {},
	) {
		super(message)
		this.name = 'ScriptExecutionError'
		this.details = options.details
		this.hint = options.hint
		this.context = options.context
		this.diagnostics = options.diagnostics
	}
}

export function scriptFailure(
	error: unknown,
	fallback = 'execution_failed',
	diagnostics?: Pick<ScriptFailure, 'hint' | 'context'>,
): ScriptFailure {
	const details = {
		...(diagnostics?.hint === undefined ? {} : { hint: diagnostics.hint.slice(0, 4096) }),
		...(diagnostics?.context === undefined ? {} : { context: snapshotJson(diagnostics.context) }),
	}
	if (error instanceof Error) {
		let message =
			error instanceof ScriptError ? error.details.message.slice(0, 4096) : failureMessage(error)
		let failureDetails: ScriptErrorDetails | undefined
		const originalDetails =
			error instanceof ScriptError || error instanceof ScriptExecutionError
				? error.details
				: undefined
		if (originalDetails !== undefined) {
			try {
				failureDetails = snapshotJson(originalDetails) as ScriptErrorDetails
			} catch (encodingError) {
				// Invalid custom details must not prevent the execution owner from settling.
				const reason =
					encodingError instanceof Error ? failureMessage(encodingError) : 'Invalid JSON'
				message = `${message} | Failure details could not be encoded: ${reason}`.slice(0, 4096)
			}
		}
		let context: JsonValue | undefined
		if (error instanceof ScriptExecutionError && error.context !== undefined) {
			try {
				context = snapshotJson(error.context)
			} catch (encodingError) {
				const reason =
					encodingError instanceof Error ? failureMessage(encodingError) : 'Invalid JSON'
				message = `${message} | Failure context could not be encoded: ${reason}`.slice(0, 4096)
			}
		}
		const compilerDiagnostics = failureDiagnostics(ownData(error, 'diagnostics'))
		return {
			code: 'code' in error && typeof error.code === 'string' ? error.code : fallback,
			message,
			...(failureDetails === undefined ? {} : { details: failureDetails }),
			...(error.stack ? { stack: error.stack.slice(0, 16_384) } : {}),
			...(error instanceof ScriptExecutionError && error.hint !== undefined
				? { hint: error.hint.slice(0, 4096) }
				: {}),
			...(context === undefined ? {} : { context }),
			...(compilerDiagnostics.length === 0 ? {} : { diagnostics: compilerDiagnostics }),
			...details,
		}
	}
	return {
		code: fallback,
		message: typeof error === 'string' ? error.slice(0, 4096) : 'Script threw a non-Error value',
		...details,
	}
}

function ownData(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key)
	return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

/** Preserve compiler facts without evaluating arbitrary Error or diagnostic accessors. */
function failureDiagnostics(value: unknown): readonly ScriptDiagnostic[] {
	if (!Array.isArray(value)) return []
	const diagnostics: ScriptDiagnostic[] = []
	for (let index = 0; index < Math.min(value.length, 100); index++) {
		const item = ownData(value, String(index))
		if (!item || typeof item !== 'object') continue
		const code = ownData(item, 'code')
		const message = ownData(item, 'message')
		if (typeof code !== 'number' || !Number.isInteger(code) || typeof message !== 'string') continue
		const file = ownData(item, 'file')
		const line = ownData(item, 'line')
		const column = ownData(item, 'column')
		diagnostics.push({
			code,
			message: message.slice(0, 4096),
			...(typeof file === 'string' ? { file: file.slice(0, 4096) } : {}),
			...(typeof line === 'number' && Number.isSafeInteger(line) && line > 0 ? { line } : {}),
			...(typeof column === 'number' && Number.isSafeInteger(column) && column > 0
				? { column }
				: {}),
		})
	}
	return diagnostics
}

function failureMessage(error: Error): string {
	const seen = new Set<Error>()
	let remaining = 16
	const read = (value: unknown, depth: number): string => {
		if (remaining-- <= 0) return '[error limit]'
		if (!(value instanceof Error))
			return typeof value === 'string' ? value.slice(0, 4096) : 'Non-Error value'
		if (seen.has(value)) return '[circular error]'
		seen.add(value)
		const originalMessage = ownData(value, 'message')
		const message = typeof originalMessage === 'string' ? originalMessage.slice(0, 4096) : 'Error'
		if (depth >= 3) return message
		const nested: unknown[] = []
		if (value instanceof SuppressedError)
			nested.push(ownData(value, 'error'), ownData(value, 'suppressed'))
		else if (value instanceof AggregateError) {
			const errors = ownData(value, 'errors')
			if (Array.isArray(errors)) {
				const length = ownData(errors, 'length')
				if (typeof length === 'number')
					for (let index = 0; index < Math.min(length, 4); index++)
						nested.push(ownData(errors, String(index)))
			}
		}
		// Native Error/Panic metadata is own data. Never execute author accessors
		// while traversing causes or aggregate/suppressed errors for a receipt.
		const cause = ownData(value, 'cause')
		if (cause !== undefined) nested.push(cause)
		return [message, ...nested.map((nestedError: unknown) => read(nestedError, depth + 1))]
			.join(' | ')
			.slice(0, 4096)
	}
	return read(error, 0)
}

const encoder = new TextEncoder()
export function scriptByteLength(value: string): number {
	return encoder.encode(value).byteLength
}

/** Native JSON conventions plus registered Plugin address identities; never evaluates behavior. */
export function snapshotJson(
	value: unknown,
	limits: Readonly<{ bytes?: number; depth?: number; nodes?: number }> = {},
): JsonValue {
	const maxBytes = limits.bytes ?? SCRIPT_VALUE_BYTES
	const maxDepth = limits.depth ?? 64
	const maxNodes = limits.nodes ?? 100_000
	const active = new Set<object>()
	let nodes = 0
	let bytes = 0
	const propertyPath = (path: string, key: string): string =>
		/^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
	const unsupported = (path: string, valueKind: string, message: string): never => {
		throw new ScriptExecutionError(
			'result_not_serializable',
			`${message} at ${path} (${valueKind})`,
			{
				context: { path, valueKind },
			},
		)
	}
	const charge = (size: number) => {
		bytes += size
		if (bytes > maxBytes)
			throw new ScriptExecutionError(
				'result_too_large',
				`JSON value exceeds ${maxBytes === SCRIPT_VALUE_BYTES ? '1 MiB' : `${maxBytes} bytes`}`,
			)
	}
	const visit = (input: unknown, depth: number, path: string): JsonValue => {
		if (++nodes > maxNodes || depth > maxDepth)
			throw new ScriptExecutionError(
				'result_too_large',
				'JSON value exceeds the depth or node limit',
			)
		if (input === null || input === undefined) {
			charge(4)
			return null
		}
		if (typeof input === 'string') {
			charge(scriptByteLength(JSON.stringify(input)))
			return input
		}
		if (typeof input === 'boolean') {
			charge(5)
			return input
		}
		if (typeof input === 'number' && Number.isFinite(input)) {
			charge(String(input).length)
			return input
		}
		if (typeof input !== 'object')
			return unsupported(
				path,
				typeof input === 'number' ? 'non-finite number' : typeof input,
				'Return JSON data; functions, symbols, BigInt and non-finite numbers are unsupported',
			)
		const array = Array.isArray(input)
		const prototype = array ? null : Object.getPrototypeOf(input)
		if (!array && prototype !== Object.prototype && prototype !== null)
			return unsupported(
				path,
				'class instance',
				'Return a plain JSON projection, not a class instance or capability',
			)
		// Only the original frozen value can shed execution evidence at this DTO
		// boundary. Continue through this visit so identity fields use the same budget.
		let identity: PluginNodeAddress | undefined
		try {
			if (readPluginNodeAddressEvidence(input as PluginNodeAddress) !== undefined)
				identity = parsePluginNodeAddress(input)
		} catch (error) {
			if (!(error instanceof DetachedPluginNodeAddressError)) throw error
			return unsupported(path, 'detached plugin address', error.message)
		}
		const data = identity ?? input
		if (active.has(data)) return unsupported(path, 'circular reference', 'Circular JSON result')
		active.add(data)
		charge(2)
		try {
			if (Array.isArray(data)) {
				if (data.length > maxNodes)
					throw new ScriptExecutionError('result_too_large', 'JSON array exceeds the node limit')
				const result: JsonValue[] = []
				for (let index = 0; index < data.length; index++) {
					const itemPath = `${path}[${index}]`
					const descriptor = Object.getOwnPropertyDescriptor(data, String(index))
					if (descriptor && !('value' in descriptor))
						return unsupported(itemPath, 'accessor', 'JSON accessors are unsupported')
					charge(1)
					result.push(visit(descriptor?.value, depth + 1, itemPath))
				}
				return result
			}
			const result: Record<string, JsonValue> = {}
			for (const key of Reflect.ownKeys(data)) {
				const descriptor = Object.getOwnPropertyDescriptor(data, key)!
				if (!descriptor.enumerable) continue
				if (typeof key !== 'string')
					return unsupported(
						`${path}[${String(key)}]`,
						'symbol key',
						'JSON symbols are unsupported',
					)
				const itemPath = propertyPath(path, key)
				if (!('value' in descriptor))
					return unsupported(itemPath, 'accessor', 'JSON accessors are unsupported')
				if (descriptor.value === undefined) continue
				charge(scriptByteLength(JSON.stringify(key)) + 2)
				Object.defineProperty(result, key, {
					value: visit(descriptor.value, depth + 1, itemPath),
					enumerable: true,
					configurable: true,
					writable: true,
				})
			}
			return result
		} finally {
			active.delete(data)
		}
	}
	return visit(value, 0, '$')
}

export async function hashScriptSource(source: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(source)))
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Identifies submitted content before delivery; server recomputes it at admission. */
export async function scriptRequestHash(
	input: ScriptSubmission | ScriptControlSubmission,
): Promise<string> {
	const canonical = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(canonical)
		if (value && typeof value === 'object')
			return Object.fromEntries(
				Object.keys(value)
					.sort()
					.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
					.map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
			)
		return value
	}
	return hashScriptSource(JSON.stringify(canonical(input)))
}

export function isScriptFinished(
	snapshot: ScriptRunSnapshot,
): snapshot is Extract<ScriptRunSnapshot, { state: 'succeeded' | 'failed' | 'cancelled' }> {
	return (
		snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled'
	)
}

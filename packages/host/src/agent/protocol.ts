/** Script control and artifact versions are independent from application/Plugin ABI. */
export const SCRIPT_PROTOCOL = 2 as const
export const SCRIPT_ARTIFACT_FORMAT = 'pluxel-js-factory/1' as const
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
/** Self-contained function body which returns an object of module exports. */
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
export type ScriptFailure = Readonly<{ code: string; message: string; stack?: string }>
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
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
		this.name = 'ScriptExecutionError'
	}
}

export function scriptFailure(error: unknown, fallback = 'execution_failed'): ScriptFailure {
	if (error instanceof Error) {
		return {
			code: 'code' in error && typeof error.code === 'string' ? error.code : fallback,
			message: failureMessage(error),
			...(error.stack ? { stack: error.stack.slice(0, 16_384) } : {}),
		}
	}
	return {
		code: fallback,
		message: typeof error === 'string' ? error.slice(0, 4096) : 'Script threw a non-Error value',
	}
}

function failureMessage(error: Error): string {
	const seen = new Set<Error>()
	let remaining = 16
	const ownData = (value: object, key: string): unknown => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return descriptor && 'value' in descriptor ? descriptor.value : undefined
	}
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

/** Native JSON undefined conventions; values with behavior are rejected, never evaluated. */
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
	const charge = (size: number) => {
		bytes += size
		if (bytes > maxBytes)
			throw new ScriptExecutionError(
				'result_too_large',
				`JSON value exceeds ${maxBytes === SCRIPT_VALUE_BYTES ? '1 MiB' : `${maxBytes} bytes`}`,
			)
	}
	const visit = (input: unknown, depth: number): JsonValue => {
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
			throw new ScriptExecutionError(
				'result_not_serializable',
				'Return JSON data; functions, symbols, BigInt and non-finite numbers are unsupported',
			)
		if (active.has(input))
			throw new ScriptExecutionError('result_not_serializable', 'Circular JSON result')
		const array = Array.isArray(input)
		if (
			!array &&
			Object.getPrototypeOf(input) !== Object.prototype &&
			Object.getPrototypeOf(input) !== null
		)
			throw new ScriptExecutionError(
				'result_not_serializable',
				'Return a plain JSON projection, not a class instance or capability',
			)
		active.add(input)
		charge(2)
		try {
			if (array) {
				if (input.length > maxNodes)
					throw new ScriptExecutionError('result_too_large', 'JSON array exceeds the node limit')
				const result: JsonValue[] = []
				for (let index = 0; index < input.length; index++) {
					const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
					if (descriptor && !('value' in descriptor))
						throw new ScriptExecutionError(
							'result_not_serializable',
							'JSON accessors are unsupported',
						)
					charge(1)
					result.push(visit(descriptor?.value, depth + 1))
				}
				return result
			}
			const result: Record<string, JsonValue> = {}
			for (const key of Reflect.ownKeys(input)) {
				const descriptor = Object.getOwnPropertyDescriptor(input, key)!
				if (!descriptor.enumerable) continue
				if (typeof key !== 'string' || !('value' in descriptor))
					throw new ScriptExecutionError(
						'result_not_serializable',
						'JSON symbols and accessors are unsupported',
					)
				if (descriptor.value === undefined) continue
				charge(scriptByteLength(JSON.stringify(key)) + 2)
				Object.defineProperty(result, key, {
					value: visit(descriptor.value, depth + 1),
					enumerable: true,
					configurable: true,
					writable: true,
				})
			}
			return result
		} finally {
			active.delete(input)
		}
	}
	return visit(value, 0)
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

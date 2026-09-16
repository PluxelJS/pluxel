/** Internal, versioned local wire protocol. No Plugin or Vite objects cross this boundary. */
export const DEV_CONSOLE_PROTOCOL = 1 as const
export const DEV_CONSOLE_FRAME_BYTES = 2 * 1024 * 1024
export const DEV_CONSOLE_VALUE_BYTES = 1024 * 1024
export const DEV_CONSOLE_DEFAULT_TIMEOUT = 30_000
export const DEV_CONSOLE_MAX_TIMEOUT = 300_000

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue }
export type DevConsoleInstance = Readonly<{
	protocol: 1
	instanceId: string
	nonce: string
	pid: number
	root: string
	socketPath: string
	startedAt: string
}>
export type DevConsoleRunInput = Readonly<{
	runId: string
	file: string
	sourceHash: string
	exportName: string
	input?: JsonValue
	timeoutMs?: number
}>
export type DevConsoleRequest = Readonly<{
	protocol: 1
	instanceId: string
	nonce: string
}> &
	(
		| Readonly<{ method: 'inspect' }>
		| (Readonly<{ method: 'run' }> & DevConsoleRunInput)
		| Readonly<{ method: 'result' | 'cancel'; runId: string }>
	)
export type DevConsolePhase = 'admission' | 'load' | 'execute' | 'encode' | 'cleanup'
export type DevConsoleFailure = Readonly<{ code: string; message: string; stack?: string }>
type RunMetadata = Readonly<{
	runId: string
	instanceId: string
	file: string
	exportName: string
	sourceHash: string
	submittedAt: string
	startedAt?: string
	hostEpoch?: string
	revisions?: Readonly<{ before?: JsonValue; after?: JsonValue }>
	logs?: Readonly<{ before?: JsonValue; after?: JsonValue }>
}>
export type DevConsoleRunSnapshot = RunMetadata &
	(
		| Readonly<{
				state: 'queued' | 'preparing' | 'running' | 'cancelling'
				phase: DevConsolePhase
				cancelReason?: string
		  }>
		| Readonly<{ state: 'succeeded'; finishedAt: string; value: JsonValue }>
		| Readonly<{
				state: 'failed' | 'cancelled'
				finishedAt: string
				phase: DevConsolePhase
				error: DevConsoleFailure
				cleanupError?: DevConsoleFailure
		  }>
	)
export type DevConsoleResponse =
	| Readonly<{ ok: true; value: unknown }>
	| Readonly<{ ok: false; error: DevConsoleFailure }>

export class ConsoleExecutionError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
		this.name = 'ConsoleExecutionError'
	}
}

export function consoleFailure(error: unknown, fallback = 'execution_failed'): DevConsoleFailure {
	if (error instanceof Error) {
		const code = 'code' in error && typeof error.code === 'string' ? error.code : fallback
		return {
			code,
			message: error.message.slice(0, 4096),
			...(error.stack ? { stack: error.stack.slice(0, 16384) } : {}),
		}
	}
	return {
		code: fallback,
		message: typeof error === 'string' ? error.slice(0, 4096) : 'Script threw a non-Error value',
	}
}

/** Native JSON conventions for undefined; reject capabilities, accessors and lossy numeric values. */
export function snapshotJson(value: unknown): JsonValue {
	const active = new Set<object>()
	let nodes = 0
	let bytes = 0
	const charge = (size: number) => {
		bytes += size
		if (bytes > DEV_CONSOLE_VALUE_BYTES)
			throw new ConsoleExecutionError('result_too_large', 'JSON value exceeds 1 MiB')
	}
	const visit = (input: unknown, depth: number): JsonValue => {
		if (++nodes > 100_000 || depth > 64)
			throw new ConsoleExecutionError(
				'result_too_large',
				'JSON value exceeds the depth or node limit',
			)
		if (input === null || input === undefined) {
			charge(4)
			return null
		}
		if (typeof input === 'string') {
			charge(Buffer.byteLength(JSON.stringify(input)))
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
			throw new ConsoleExecutionError(
				'result_not_serializable',
				'Return JSON data; functions, symbols, BigInt and non-finite numbers are unsupported',
			)
		if (active.has(input))
			throw new ConsoleExecutionError('result_not_serializable', 'Circular JSON result')
		const array = Array.isArray(input)
		if (
			!array &&
			Object.getPrototypeOf(input) !== Object.prototype &&
			Object.getPrototypeOf(input) !== null
		) {
			throw new ConsoleExecutionError(
				'result_not_serializable',
				'Return a plain JSON projection, not a class instance or capability',
			)
		}
		active.add(input)
		charge(2)
		try {
			if (array) {
				if (input.length > 100_000)
					throw new ConsoleExecutionError('result_too_large', 'JSON array exceeds the node limit')
				const result: JsonValue[] = []
				for (let index = 0; index < input.length; index++) {
					const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
					if (descriptor && !('value' in descriptor))
						throw new ConsoleExecutionError(
							'result_not_serializable',
							'JSON accessors are unsupported',
						)
					charge(1)
					result.push(visit(descriptor?.value, depth + 1))
				}
				return result
			}
			const result: Record<string, JsonValue> = Object.create(null)
			for (const key of Reflect.ownKeys(input)) {
				const descriptor = Object.getOwnPropertyDescriptor(input, key)!
				if (!descriptor.enumerable) continue
				if (typeof key !== 'string' || !('value' in descriptor))
					throw new ConsoleExecutionError(
						'result_not_serializable',
						'JSON symbols and accessors are unsupported',
					)
				if (descriptor.value === undefined) continue
				charge(Buffer.byteLength(JSON.stringify(key)) + 2)
				result[key] = visit(descriptor.value, depth + 1)
			}
			return result
		} finally {
			active.delete(input)
		}
	}
	return visit(value, 0)
}

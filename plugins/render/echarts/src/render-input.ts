import { EChartsError } from './errors.ts'

const UTF8_MEASURE_CHUNK_CHARACTERS = 64 * 1024

export type RenderDataBudget = Readonly<{
	maxBytes: number
	maxNodes: number
	maxDepth: number
}>

/**
 * Validate the declarative payload before it reaches the worker transport.
 *
 * Runtime owns worker admission and cloning; ECharts owns which values it can serialize and the
 * bounded work needed to inspect them. Keeping that policy in this local module makes it directly
 * testable without granting a Plugin test access to Runtime's node-artifact internals.
 */
export async function assertRenderDataBudget(
	roots: readonly unknown[],
	limits: RenderDataBudget,
	signal: AbortSignal,
): Promise<void> {
	const stack: Array<Readonly<{ value: unknown; depth: number }>> = roots.map((value) => ({
		value,
		depth: 0,
	}))
	const seen = new WeakSet<object>()
	let bytes = 0
	let nodes = 0
	const addBytes = (value: number): void => {
		bytes += value
		if (!Number.isSafeInteger(bytes) || bytes > limits.maxBytes) {
			throw new EChartsError(
				'OPTION_TOO_LARGE',
				`ECharts option exceeds the configured ${limits.maxBytes} byte budget`,
			)
		}
	}
	while (stack.length > 0) {
		if (nodes > 0 && nodes % 2_048 === 0) await yieldToEventLoop(signal)
		const current = stack.pop()!
		if (++nodes > limits.maxNodes) {
			throw new EChartsError(
				'OPTION_TOO_LARGE',
				`ECharts option exceeds the configured ${limits.maxNodes} value budget`,
			)
		}
		if (current.depth > limits.maxDepth) {
			throw new EChartsError(
				'OPTION_TOO_LARGE',
				`ECharts option exceeds the configured ${limits.maxDepth} level depth budget`,
			)
		}
		const value = current.value
		if (value === null || value === undefined || typeof value === 'boolean') {
			addBytes(4)
			continue
		}
		if (typeof value === 'number') {
			addBytes(8)
			continue
		}
		if (typeof value === 'string') {
			const measured = measureUtf8UpTo(value, limits.maxBytes - bytes, signal)
			addBytes(typeof measured === 'number' ? measured : await measured)
			continue
		}
		if (typeof value !== 'object') {
			throw new EChartsError(
				'WORKER_INPUT_UNSUPPORTED',
				'ECharts options must contain only declarative structured-clone-compatible data',
			)
		}
		if (seen.has(value)) continue
		seen.add(value)
		if (value instanceof SharedArrayBuffer) {
			throw new EChartsError(
				'WORKER_INPUT_UNSUPPORTED',
				'ECharts options must not contain shared mutable memory',
			)
		}
		if (value instanceof ArrayBuffer) {
			addBytes(value.byteLength)
			continue
		}
		if (ArrayBuffer.isView(value)) {
			if (value.buffer instanceof SharedArrayBuffer) {
				throw new EChartsError(
					'WORKER_INPUT_UNSUPPORTED',
					'ECharts options must not contain shared mutable memory',
				)
			}
			addBytes(value.byteLength)
			continue
		}
		if (!Array.isArray(value) && !isPlainRecord(value)) {
			throw new EChartsError(
				'WORKER_INPUT_UNSUPPORTED',
				'ECharts options must use plain objects, arrays, typed arrays, and scalar values',
			)
		}
		if (Array.isArray(value)) addBytes(value.length * 4)
		for (const symbol of Object.getOwnPropertySymbols(value)) {
			if (Object.getOwnPropertyDescriptor(value, symbol)?.enumerable) {
				throw new EChartsError(
					'WORKER_INPUT_UNSUPPORTED',
					'ECharts options must not contain enumerable symbol properties',
				)
			}
		}
		for (const key of Object.keys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)!
			if (!('value' in descriptor)) {
				throw new EChartsError(
					'WORKER_INPUT_UNSUPPORTED',
					'ECharts options must not contain accessor properties',
				)
			}
			const measured = measureUtf8UpTo(key, limits.maxBytes - bytes, signal)
			addBytes((typeof measured === 'number' ? measured : await measured) + 4)
			stack.push({ value: descriptor.value, depth: current.depth + 1 })
		}
	}
}

function measureUtf8UpTo(
	value: string,
	maxBytes: number,
	signal: AbortSignal,
): number | Promise<number> {
	if (signal.aborted) throw abortReason(signal)
	if (value.length <= UTF8_MEASURE_CHUNK_CHARACTERS) return Buffer.byteLength(value, 'utf8')
	return measureLargeUtf8UpTo(value, maxBytes, signal)
}

async function measureLargeUtf8UpTo(
	value: string,
	maxBytes: number,
	signal: AbortSignal,
): Promise<number> {
	let byteLength = 0
	for (let offset = 0; offset < value.length;) {
		let end = Math.min(offset + UTF8_MEASURE_CHUNK_CHARACTERS, value.length)
		if (
			end < value.length &&
			isHighSurrogate(value.charCodeAt(end - 1)) &&
			isLowSurrogate(value.charCodeAt(end))
		) {
			end += 1
		}
		byteLength += Buffer.byteLength(value.slice(offset, end), 'utf8')
		if (byteLength > maxBytes) return byteLength
		offset = end
		if (offset < value.length) await yieldToEventLoop(signal)
	}
	return byteLength
}

function isHighSurrogate(value: number): boolean {
	return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
	return value >= 0xdc00 && value <= 0xdfff
}

async function yieldToEventLoop(signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve))
	if (signal.aborted) throw abortReason(signal)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value) as unknown
	return prototype === Object.prototype || prototype === null
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException('ECharts rendering aborted', 'AbortError')
}

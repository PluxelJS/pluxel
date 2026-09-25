export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue }

export class JsonWireError extends TypeError {
	constructor(readonly code: 'OUTPUT_ENCODING' | 'OUTPUT_LIMIT') {
		super(
			code === 'OUTPUT_LIMIT'
				? 'Command output exceeds the wire limit'
				: 'Command output is not JSON data',
		)
	}
}

/** Validate and detach a plain JSON value without calling getters or toJSON. */
export function copyJson(value: unknown, maxBytes: number): { value: JsonValue; text: string } {
	let nodes = 0
	const seen = new WeakSet<object>()
	const copy = (input: unknown, depth: number): JsonValue => {
		if (++nodes > 10_000 || depth > 32) throw new JsonWireError('OUTPUT_LIMIT')
		if (input === null) return null
		if (typeof input === 'string' || typeof input === 'boolean') return input
		if (typeof input === 'number' && Number.isFinite(input)) return input
		if (typeof input !== 'object') throw new JsonWireError('OUTPUT_ENCODING')
		if (seen.has(input)) throw new JsonWireError('OUTPUT_ENCODING')
		seen.add(input)
		if (Array.isArray(input)) {
			if (
				Object.getPrototypeOf(input) !== Array.prototype ||
				input.length > 10_000 ||
				Object.getOwnPropertySymbols(input).length > 0
			) {
				throw new JsonWireError('OUTPUT_ENCODING')
			}
			const descriptors = Object.getOwnPropertyDescriptors(input)
			if (
				Object.keys(descriptors).some(
					(key) => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length),
				)
			) {
				throw new JsonWireError('OUTPUT_ENCODING')
			}
			for (let index = 0; index < input.length; index++) {
				if (!descriptors[index] || !('value' in descriptors[index]))
					throw new JsonWireError('OUTPUT_ENCODING')
			}
			const result = Array.from({ length: input.length }, (_, index) =>
				copy(descriptors[index].value, depth + 1),
			)
			seen.delete(input)
			return result
		}
		const prototype = Object.getPrototypeOf(input)
		if (prototype !== Object.prototype && prototype !== null)
			throw new JsonWireError('OUTPUT_ENCODING')
		if (Object.getOwnPropertySymbols(input).length > 0) throw new JsonWireError('OUTPUT_ENCODING')
		const result: Record<string, JsonValue> = Object.create(null)
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
			if (!descriptor.enumerable || !('value' in descriptor))
				throw new JsonWireError('OUTPUT_ENCODING')
			result[key] = copy(descriptor.value, depth + 1)
		}
		seen.delete(input)
		return result
	}
	const detached = copy(value === undefined ? null : value, 0)
	const text = JSON.stringify(detached)
	if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new JsonWireError('OUTPUT_LIMIT')
	return { value: detached, text }
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface NativeTransport {
	request(method: string, params: Json, signal?: AbortSignal): Promise<Json>
}

export function encodeJson(value: unknown): string {
	const seen = new Set<object>()
	function check(item: unknown): void {
		if (item === null || typeof item === 'string' || typeof item === 'boolean') return
		if (typeof item === 'number' && Number.isFinite(item)) return
		if (typeof item !== 'object') throw new TypeError('Wire values must be JSON data')
		if (seen.has(item)) throw new TypeError('Cyclic wire value')
		if (
			!Array.isArray(item) &&
			Object.getPrototypeOf(item) !== Object.prototype &&
			Object.getPrototypeOf(item) !== null
		)
			throw new TypeError('Wire objects must be plain')
		seen.add(item)
		for (const child of Object.values(item)) check(child)
		seen.delete(item)
	}
	check(value)
	const text = JSON.stringify(value)
	if (new TextEncoder().encode(text).byteLength > 1024 * 1024)
		throw new RangeError('Wire frame exceeds 1 MiB')
	return text
}

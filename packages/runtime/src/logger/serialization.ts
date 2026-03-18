function isErrorLike(value: unknown): value is Error {
	return value instanceof Error
}

export function toPlainObject(value: unknown, depth = 4, seen?: WeakSet<object>): unknown {
	if (depth < 0) return '[MaxDepth]'
	if (value === null) return null
	if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}…` : value
	if (typeof value === 'number' || typeof value === 'boolean') return value
	if (typeof value === 'bigint') return `${value}n`
	if (typeof value === 'undefined') return undefined
	if (typeof value === 'symbol') return value.toString()
	if (typeof value === 'function') {
		const name = (value as { name?: unknown }).name
		return `[Function ${typeof name === 'string' && name ? name : 'anonymous'}]`
	}

	if (isErrorLike(value)) {
		seen ??= new WeakSet<object>()
		const errorRecord = value as unknown as Record<string, unknown>
		const extra: Record<string, unknown> = {}
		for (const k in errorRecord) {
			if (!Object.hasOwn(errorRecord, k)) continue
			extra[k] = toPlainObject(errorRecord[k], depth - 1, seen)
		}
		const cause = (value as { cause?: unknown }).cause
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
			cause: cause ? toPlainObject(cause, depth - 1, seen) : undefined,
			...extra,
		}
	}

	if (value instanceof Date) return value.toISOString()
	if (value instanceof URL) return value.toString()

	if (Array.isArray(value)) {
		const limit = Math.min(value.length, 200)
		return value.slice(0, limit).map((v) => toPlainObject(v, depth - 1, seen))
	}

	if (value instanceof Map) {
		const entries: Array<[unknown, unknown]> = []
		let count = 0
		for (const [k, v] of value) {
			if (count++ >= 200) break
			entries.push([toPlainObject(k, depth - 1, seen), toPlainObject(v, depth - 1, seen)])
		}
		return { type: 'Map', size: value.size, entries }
	}

	if (value instanceof Set) {
		const values: unknown[] = []
		let count = 0
		for (const v of value) {
			if (count++ >= 200) break
			values.push(toPlainObject(v, depth - 1, seen))
		}
		return { type: 'Set', size: value.size, values }
	}

	if (typeof value === 'object') {
		seen ??= new WeakSet<object>()
		const obj = value as object
		if (seen.has(obj)) return '[Circular]'
		seen.add(obj)

		const out: Record<string, unknown> = {}
		let count = 0
		for (const k in value as Record<string, unknown>) {
			if (!Object.hasOwn(value as Record<string, unknown>, k)) continue
			if (count++ >= 200) break
			out[k] = toPlainObject((value as Record<string, unknown>)[k], depth - 1, seen)
		}
		return out
	}

	return String(value)
}

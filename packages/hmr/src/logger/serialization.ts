function isErrorLike(value: unknown): value is Error {
	return value instanceof Error
}

export function toPlainObject(value: unknown, depth = 4, seen = new WeakSet<object>()): unknown {
	if (depth < 0) return '[MaxDepth]'
	if (value === null) return null
	const t = typeof value
	if (t === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}…` : value
	if (t === 'number' || t === 'boolean') return value
	if (t === 'bigint') return `${value}n`
	if (t === 'undefined') return undefined
	if (t === 'symbol') return value.toString()
	if (t === 'function') return `[Function ${(value as Function).name || 'anonymous'}]`

	if (isErrorLike(value)) {
		const extra: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value as any)) {
			extra[k] = toPlainObject(v, depth - 1, seen)
		}
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
			cause: (value as any).cause ? toPlainObject((value as any).cause, depth - 1, seen) : undefined,
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
		const obj = value as object
		if (seen.has(obj)) return '[Circular]'
		seen.add(obj)

		const out: Record<string, unknown> = {}
		let count = 0
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (count++ >= 200) break
			out[k] = toPlainObject(v, depth - 1, seen)
		}
		return out
	}

	return String(value)
}

export function messageToString(message: readonly unknown[]): string {
	let out = ''
	for (const part of message) {
		if (typeof part === 'string') out += part
		else if (typeof part === 'number' || typeof part === 'boolean' || typeof part === 'bigint')
			out += String(part)
		else if (isErrorLike(part)) out += part.message || part.name
		else {
			try {
				out += JSON.stringify(toPlainObject(part), null, 0)
			} catch {
				out += String(part)
			}
		}
	}
	return out
}

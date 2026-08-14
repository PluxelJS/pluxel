export class JsonValueError extends TypeError {
	readonly path: Array<string | number>
	readonly reason: string

	constructor(reason: string, path: Array<string | number>) {
		super(`Value at ${formatPath(path)} is not valid JSON: ${reason}`)
		this.name = 'JsonValueError'
		this.path = path
		this.reason = reason
	}
}

const strictJsonSnapshots = new WeakSet<object>()

/** Marks a snapshot only after its complete value has crossed the strict JSON boundary. */
export function markStrictJsonSnapshot<T>(value: T): T {
	if (value && typeof value === 'object') strictJsonSnapshots.add(value)
	return value
}

export function isStrictJsonSnapshot(value: unknown): boolean {
	return !!value && typeof value === 'object' && strictJsonSnapshots.has(value)
}

/** Clones a JSON value without the coercions and data loss of JSON.stringify(). */
export function cloneJsonValue(value: unknown, options?: { ignoreSymbols?: boolean }): unknown {
	return walk(value, [], new WeakSet<object>(), true, options?.ignoreSymbols === true)
}

/** Verifies values inserted by schema defaults without allocating a second clone. */
export function assertJsonValue(value: unknown): void {
	walk(value, [], new WeakSet<object>(), false, false)
}

function walk(
	value: unknown,
	path: Array<string | number>,
	ancestors: WeakSet<object>,
	copy: boolean,
	ignoreSymbols: boolean,
): unknown {
	assertPrimitive(value, path)
	if (value === null || typeof value !== 'object') return value
	enter(value, path, ancestors)
	try {
		if (Array.isArray(value)) {
			const output: unknown[] = copy ? [] : value
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
				if (!descriptor) throw new JsonValueError('sparse array', [...path, index])
				if (!descriptor.enumerable || !('value' in descriptor)) {
					throw new JsonValueError('accessor or non-enumerable item', [...path, index])
				}
				const current = walk(descriptor.value, [...path, index], ancestors, copy, ignoreSymbols)
				if (copy) output.push(current)
			}
			assertArrayKeys(value, path, ignoreSymbols)
			return output
		}
		assertPlainObject(value, path)
		const output: Record<string, unknown> = copy ? {} : (value as Record<string, unknown>)
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string') {
				if (ignoreSymbols) continue
				throw new JsonValueError('symbol-keyed property', path)
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key)!
			if (!descriptor.enumerable || !('value' in descriptor)) {
				throw new JsonValueError('accessor or non-enumerable property', [...path, key])
			}
			const current = walk(descriptor.value, [...path, key], ancestors, copy, ignoreSymbols)
			if (copy) {
				Object.defineProperty(output, key, {
					value: current,
					enumerable: true,
					configurable: true,
					writable: true,
				})
			}
		}
		return output
	} finally {
		ancestors.delete(value)
	}
}

function assertArrayKeys(
	value: unknown[],
	path: Array<string | number>,
	ignoreSymbols: boolean,
): void {
	for (const key of Reflect.ownKeys(value)) {
		if (key === 'length') continue
		if (typeof key === 'symbol') {
			if (ignoreSymbols) continue
			throw new JsonValueError('symbol-keyed array property', path)
		}
		const index = Number(key)
		if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
			throw new JsonValueError('non-index array property', [...path, key])
		}
	}
}

function assertPrimitive(value: unknown, path: Array<string | number>): void {
	if (typeof value === 'number' && !Number.isFinite(value)) {
		throw new JsonValueError('non-finite number', path)
	}
	if (
		value !== null &&
		typeof value !== 'object' &&
		typeof value !== 'string' &&
		typeof value !== 'number' &&
		typeof value !== 'boolean'
	) {
		throw new JsonValueError(typeof value, path)
	}
}

function assertPlainObject(value: object, path: Array<string | number>): void {
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new JsonValueError('non-plain object', path)
	}
}

function enter(value: object, path: Array<string | number>, ancestors: WeakSet<object>): void {
	if (ancestors.has(value)) throw new JsonValueError('cyclic reference', path)
	ancestors.add(value)
}

function formatPath(path: Array<string | number>): string {
	if (path.length === 0) return '$'
	return `$${path.map((part) => (typeof part === 'number' ? `[${part}]` : `.${part}`)).join('')}`
}

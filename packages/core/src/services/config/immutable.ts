type ConfigRecord = Record<string, unknown>

/** Clone and deeply freeze the portable data tree produced by a Plugin config schema. */
export function immutableConfigRecord(value: Readonly<ConfigRecord>): Readonly<ConfigRecord> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('[ConfigService] Config record must be a plain object')
	}
	return cloneConfigValue(value, new Set(), '$') as Readonly<ConfigRecord>
}

function cloneConfigValue(value: unknown, ancestors: Set<object>, path: string): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number') {
		if (Number.isFinite(value)) return value
		throw new TypeError(`[ConfigService] Config output at ${path} is not portable data`)
	}
	if (typeof value !== 'object') {
		throw new TypeError(`[ConfigService] Config output at ${path} is not portable data`)
	}
	if (ancestors.has(value)) {
		throw new TypeError(`[ConfigService] Config output at ${path} contains a cycle`)
	}
	ancestors.add(value)
	try {
		if (Array.isArray(value)) return cloneConfigArray(value, ancestors, path)
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError(
				`[ConfigService] Config output at ${path} must contain only plain objects and arrays`,
			)
		}
		const out: ConfigRecord = prototype === null ? Object.create(null) : {}
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string') {
				throw new TypeError(`[ConfigService] Config output at ${path} has a symbol key`)
			}
			const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
			if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
				throw new TypeError(
					`[ConfigService] Config output at ${path}.${key} must be an enumerable data property`,
				)
			}
			Object.defineProperty(out, key, {
				value: cloneConfigValue(descriptor.value, ancestors, `${path}.${key}`),
				writable: true,
				enumerable: true,
				configurable: true,
			})
		}
		return Object.freeze(out)
	} finally {
		ancestors.delete(value)
	}
}

function cloneConfigArray(
	value: readonly unknown[],
	ancestors: Set<object>,
	path: string,
): unknown {
	const out: unknown[] = []
	for (let index = 0; index < value.length; index++) {
		const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index))
		if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
			throw new TypeError(
				`[ConfigService] Config output at ${path}[${index}] must be an enumerable data property`,
			)
		}
		out.push(cloneConfigValue(descriptor.value, ancestors, `${path}[${index}]`))
	}
	for (const key of Reflect.ownKeys(value)) {
		if (key === 'length') continue
		if (typeof key === 'symbol') {
			throw new TypeError(`[ConfigService] Config output at ${path} has a symbol key`)
		}
		const index = Number(key)
		if (Number.isInteger(index) && index >= 0 && index < value.length && String(index) === key) {
			continue
		}
		throw new TypeError(`[ConfigService] Config output at ${path}.${key} is not portable data`)
	}
	return Object.freeze(out)
}

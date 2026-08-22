type ConfigRecord = Record<string, unknown>

/** Clone and deeply freeze the portable data tree produced by a Plugin config schema. */
export function immutableConfigRecord(value: Readonly<ConfigRecord>): Readonly<ConfigRecord> {
	return cloneConfigValue(value, new Set(), '$') as Readonly<ConfigRecord>
}

function cloneConfigValue(value: unknown, ancestors: Set<object>, path: string): unknown {
	if (value === null || typeof value !== 'object') {
		if (typeof value === 'function' || typeof value === 'symbol') {
			throw new TypeError(`[ConfigService] Config output at ${path} is not portable data`)
		}
		return value
	}
	if (ancestors.has(value)) {
		throw new TypeError(`[ConfigService] Config output at ${path} contains a cycle`)
	}
	ancestors.add(value)
	try {
		if (Array.isArray(value)) {
			return Object.freeze(
				value.map((item, index) => cloneConfigValue(item, ancestors, `${path}[${index}]`)),
			)
		}
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError(
				`[ConfigService] Config output at ${path} must contain only plain objects and arrays`,
			)
		}
		const out: ConfigRecord = prototype === null ? Object.create(null) : {}
		for (const [key, item] of Object.entries(value as ConfigRecord)) {
			out[key] = cloneConfigValue(item, ancestors, `${path}.${key}`)
		}
		return Object.freeze(out)
	} finally {
		ancestors.delete(value)
	}
}

import { VaultError } from './error'

export function cloneJson<T>(value: T): T {
	const seen = new Set<object>()
	const copy = (input: unknown): unknown => {
		if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
		if (typeof input === 'number' && Number.isFinite(input)) return input
		if (!input || typeof input !== 'object' || seen.has(input))
			throw new VaultError('INVALID_FORMAT', 'Vault values must be finite acyclic JSON data.')
		const prototype = Object.getPrototypeOf(input)
		if (
			Object.getOwnPropertySymbols(input).length > 0 ||
			(Array.isArray(input) && Object.keys(input).length !== input.length)
		)
			throw new VaultError(
				'INVALID_FORMAT',
				'Vault values cannot contain symbols or sparse arrays.',
			)
		if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null)
			throw new VaultError('INVALID_FORMAT', 'Vault values must be plain JSON data.')
		seen.add(input)
		try {
			const output: Record<string, unknown> | unknown[] = Array.isArray(input)
				? []
				: Object.create(null)
			for (const key of Object.keys(input)) {
				const descriptor = Object.getOwnPropertyDescriptor(input, key)!
				if (!('value' in descriptor))
					throw new VaultError('INVALID_FORMAT', 'Vault values cannot contain accessors.')
				Object.defineProperty(output, key, {
					value: copy(descriptor.value),
					enumerable: true,
					writable: true,
					configurable: true,
				})
			}
			return output
		} finally {
			seen.delete(input)
		}
	}
	return copy(value) as T
}
export function freezeJson<T>(input: T): T {
	if (input && typeof input === 'object') {
		for (const child of Object.values(input)) freezeJson(child)
		Object.freeze(input)
	}
	return input
}

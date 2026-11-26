export function assertCoreConfigObject(
	input: unknown,
	label: string,
	fields?: ReadonlySet<string>,
): void {
	if (
		!input ||
		typeof input !== 'object' ||
		Array.isArray(input) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input))
	)
		throw new TypeError(label + ' must be a plain object')
	for (const key of Reflect.ownKeys(input)) {
		if (typeof key !== 'string' || (fields && !fields.has(key)))
			throw new TypeError(label + ' includes unsupported ' + String(key))
		const descriptor = Object.getOwnPropertyDescriptor(input, key)!
		if (!descriptor.enumerable || !('value' in descriptor))
			throw new TypeError(label + ' must contain only enumerable data fields')
	}
}

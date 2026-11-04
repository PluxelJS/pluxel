/** Object layers merge recursively; arrays and scalar values occupy one atomic path. */
export function configLeafPaths(
	value: Readonly<Record<string, unknown>>,
	parent: readonly string[] = [],
): string[][] {
	return Object.entries(value).flatMap(([key, child]) => {
		const path = [...parent, key]
		return isConfigObject(child) && Object.keys(child).length > 0
			? configLeafPaths(child, path)
			: [path]
	})
}
export function isConfigObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}
export function configPathContains(parent: readonly string[], child: readonly string[]): boolean {
	return parent.length <= child.length && parent.every((part, index) => part === child[index])
}
export function configPathsOverlap(a: readonly string[], b: readonly string[]): boolean {
	return configPathContains(a, b) || configPathContains(b, a)
}
export function configHasPath(
	value: Readonly<Record<string, unknown>>,
	path: readonly string[],
): boolean {
	let current: unknown = value
	for (const key of path) {
		if (!isConfigObject(current) || !Object.hasOwn(current, key)) return false
		current = current[key]
	}
	return true
}
/** Paths address object fields; arrays are atomic and cannot be indexed. */
export function assertConfigPaths(input: unknown): asserts input is readonly (readonly string[])[] {
	const dense = (value: unknown): unknown[] => {
		if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1)
			throw new TypeError('[host] config paths require dense arrays')
		return Array.from({ length: value.length }, (_, index) => {
			const property = Object.getOwnPropertyDescriptor(value, String(index))
			if (!property?.enumerable || !('value' in property))
				throw new TypeError('[host] config paths require data elements')
			return property.value
		})
	}
	const paths = dense(input).map(dense)
	for (let index = 0; index < paths.length; index++) {
		const path = paths[index]!
		if (
			path.length === 0 ||
			path.length > 64 ||
			path.some(
				(part) =>
					typeof part !== 'string' ||
					!part ||
					part.length > 256 ||
					part.includes('\0') ||
					['__proto__', 'constructor', 'prototype'].includes(part),
			)
		)
			throw new TypeError('[host] config paths must contain safe non-empty field names')
		if (
			paths
				.slice(0, index)
				.some((previous) => configPathsOverlap(previous as string[], path as string[]))
		)
			throw new TypeError('[host] config removal paths must not overlap')
	}
}
export function removeConfigPaths(
	value: Record<string, unknown>,
	paths: readonly (readonly string[])[],
): boolean {
	let changed = false
	for (const path of paths) {
		const parents: { object: Record<string, unknown>; key: string }[] = []
		let current = value
		let present = true
		for (const key of path.slice(0, -1)) {
			if (!Object.hasOwn(current, key)) {
				present = false
				break
			}
			if (!isConfigObject(current[key]))
				throw new TypeError('[host] config removal cannot traverse arrays or scalar values')
			parents.push({ object: current, key })
			current = current[key]
		}
		if (!present || !Object.hasOwn(current, path.at(-1)!)) continue
		delete current[path.at(-1)!]
		changed = true
		for (const parent of parents.toReversed()) {
			if (Object.keys(current).length > 0) break
			delete parent.object[parent.key]
			current = parent.object
		}
	}
	return changed
}

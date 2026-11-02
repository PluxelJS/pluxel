/** Object layers merge recursively; arrays and scalar values occupy one atomic path. */
export function configLeafPaths(
	value: Readonly<Record<string, unknown>>,
	parent: readonly string[] = [],
): string[][] {
	return Object.entries(value).flatMap(([key, child]) => {
		const path = [...parent, key]
		return isConfigObject(child) ? configLeafPaths(child, path) : [path]
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
export function changedConfigPaths(
	before: Readonly<Record<string, unknown>>,
	after: Readonly<Record<string, unknown>>,
	parent: readonly string[] = [],
): string[][] {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) => {
		const left = before[key],
			right = after[key],
			path = [...parent, key]
		if (
			(isConfigObject(left) || left === undefined) &&
			(isConfigObject(right) || right === undefined) &&
			(isConfigObject(left) || isConfigObject(right))
		)
			return changedConfigPaths(
				isConfigObject(left) ? left : {},
				isConfigObject(right) ? right : {},
				path,
			)
		return JSON.stringify(left) === JSON.stringify(right) &&
			Object.hasOwn(before, key) === Object.hasOwn(after, key)
			? []
			: [path]
	})
}

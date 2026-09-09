import { makePathArray } from '@tanstack/react-form'

export type FieldPath = readonly (string | number)[]

/** Only register paths that TanStack can represent without changing literal keys. */
export function fieldName(path: FieldPath): string | undefined {
	// Empty string is parsed as a property, not a whole-value/root boundary.
	if (path.some((part) => part === '')) return undefined
	const name = path.reduce<string>(
		(result, part) =>
			typeof part === 'number' ? `${result}[${part}]` : result ? `${result}.${part}` : part,
		'',
	)
	const parsed = makePathArray(name)
	return path.length > 0 &&
		parsed.length === path.length &&
		parsed.every((part, i) => part === path[i])
		? name
		: undefined
}

export function readPath(value: unknown, path: FieldPath): unknown {
	for (const key of path) {
		if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
		value = (value as Record<string | number, unknown>)[key]
	}
	return value
}

export function writePath(value: unknown, path: FieldPath, next: unknown): unknown {
	if (path.length === 0) return next
	const [key, ...rest] = path
	const child = readPath(value, [key!])
	if (Array.isArray(value) && typeof key === 'number') {
		const result = [...value]
		result[key] = writePath(child, rest, next)
		return result
	}
	return {
		...(value !== null && typeof value === 'object' ? value : {}),
		[key!]: writePath(child, rest, next),
	}
}

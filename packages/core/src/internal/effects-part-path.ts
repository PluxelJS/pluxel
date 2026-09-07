export const EFFECTS_PART_PATH = Symbol('pluxel:effects:part-path')

type PartPathCarrier = Error & { partPath?: unknown; cause?: unknown }

function isPartPath(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** @internal Find definition-local Part attribution through nested cleanup aggregates. */
export function findErrorPartPath(
	error: unknown,
	seen: Set<object> = new Set(),
): readonly string[] | undefined {
	if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined
	if (seen.has(error)) return undefined
	seen.add(error)
	const direct = (error as PartPathCarrier).partPath
	if (isPartPath(direct)) return direct
	if (error instanceof AggregateError) {
		for (const nested of error.errors) {
			const path = findErrorPartPath(nested, seen)
			if (path) return path
		}
	}
	return findErrorPartPath((error as PartPathCarrier).cause, seen)
}

/** @internal Preserve the most specific nested Part path, or attach the owning scope path. */
export function attachErrorPartPath(error: unknown, path: readonly string[]): Error {
	const selected = findErrorPartPath(error) ?? Object.freeze([...path])
	const target = error instanceof Error ? error : new Error(String(error), { cause: error })
	try {
		Object.defineProperty(target, 'partPath', {
			value: selected,
			enumerable: false,
			configurable: false,
			writable: false,
		})
		return target
	} catch {
		const wrapped = new Error(`PluginPart ${selected.join('.')} cleanup failed`, {
			cause: target,
		}) as PartPathCarrier
		wrapped.partPath = selected
		return wrapped
	}
}

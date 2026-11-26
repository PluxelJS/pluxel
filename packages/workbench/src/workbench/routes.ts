export type CompiledWorkbenchRoute = Readonly<{
	path: string
	segments: readonly WorkbenchRouteSegment[]
	staticSegments: number
}>

type WorkbenchRouteSegment = Readonly<{ literal?: string; parameter?: string }>

export function compileWorkbenchRoute(path: string): CompiledWorkbenchRoute {
	const segments: WorkbenchRouteSegment[] = path
		.split('/')
		.filter(Boolean)
		.map<WorkbenchRouteSegment>((segment) =>
			segment.startsWith(':')
				? Object.freeze({ parameter: segment.slice(1) })
				: Object.freeze({ literal: segment }),
		)
	return Object.freeze({
		path,
		segments: Object.freeze(segments),
		staticSegments: segments.filter((segment) => segment.literal !== undefined).length,
	})
}

export function matchWorkbenchRoute(
	compiled: CompiledWorkbenchRoute,
	path: string,
): Readonly<Record<string, string>> | null {
	if (!path.startsWith('/') || /[?#\\]/.test(path)) return null
	const segments = path.slice(1).split('/')
	if (segments.length !== compiled.segments.length) return null
	const params: Record<string, string> = {}
	for (const [index, expected] of compiled.segments.entries()) {
		const actual = segments[index]!
		if (expected.literal !== undefined) {
			if (expected.literal !== actual) return null
			continue
		}
		if (!expected.parameter || actual === `:${expected.parameter}`) return null
		try {
			const value = decodeURIComponent(actual)
			if (!isWorkbenchRouteParameter(value)) return null
			params[expected.parameter] = value
		} catch {
			return null
		}
	}
	return Object.freeze(params)
}

export function workbenchRoutesOverlap(
	left: CompiledWorkbenchRoute,
	right: CompiledWorkbenchRoute,
): boolean {
	if (left.segments.length !== right.segments.length) return false
	return left.segments.every((segment, index) => {
		const other = right.segments[index]!
		return (
			segment.parameter !== undefined ||
			other.parameter !== undefined ||
			segment.literal === other.literal
		)
	})
}

export function isWorkbenchRouteParameter(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 512 &&
		value !== '.' &&
		value !== '..' &&
		value.isWellFormed() &&
		!/[\\/]/.test(value)
	)
}

import { normalizeWorkbenchPath } from './paths'

export type CompiledWorkbenchRoute = Readonly<{
	identity: string
	path: string
	segments: readonly WorkbenchRouteSegment[]
	staticSegments: number
}>

type WorkbenchRouteSegment = Readonly<{ literal?: string; parameter?: string }>

export function compileWorkbenchRoute(path: string): CompiledWorkbenchRoute {
	const normalized = normalizeWorkbenchPath(path)
	const segments: WorkbenchRouteSegment[] = normalized
		.split('/')
		.filter(Boolean)
		.map<WorkbenchRouteSegment>((segment) =>
			segment.startsWith(':')
				? Object.freeze({ parameter: segment.slice(1) })
				: Object.freeze({ literal: segment }),
		)
	return Object.freeze({
		identity: segments
			.map((segment) => (segment.parameter === undefined ? segment.literal : ':'))
			.join('/'),
		path: normalized,
		segments: Object.freeze(segments),
		staticSegments: segments.filter((segment) => segment.literal !== undefined).length,
	})
}

export function matchWorkbenchRoute(
	compiled: CompiledWorkbenchRoute,
	path: string,
): Readonly<Record<string, string>> | null {
	const segments = normalizeWorkbenchPath(path).split('/').filter(Boolean)
	if (segments.length !== compiled.segments.length) return null
	const params: Record<string, string> = {}
	for (const [index, expected] of compiled.segments.entries()) {
		const actual = segments[index]!
		if (expected.literal !== undefined) {
			if (expected.literal !== actual) return null
			continue
		}
		if (!expected.parameter) return null
		params[expected.parameter] = decodeSegment(actual)
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

function decodeSegment(value: string): string {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

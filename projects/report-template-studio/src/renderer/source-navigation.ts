import type { CompileResult } from '../shared/contracts'

export type PreviewNavigation = NonNullable<CompileResult['preview']['navigation']>
export type PreviewPoint = PreviewNavigation['points'][number]
export type SourcePosition = { path: string; line: number; column: number }

/** Native compiler rectangles use page-local points, independent of preview zoom. */
export function pointAtPreview(
	points: readonly PreviewPoint[],
	page: number,
	x: number,
	y: number,
): PreviewPoint | undefined {
	let closest: PreviewPoint | undefined
	let distance = Infinity
	let area = Infinity
	for (const point of points) {
		if (point.page !== page) continue
		const dx = Math.max(point.x - x, 0, x - point.x - point.width)
		const dy = Math.max(point.y - y, 0, y - point.y - point.height)
		const nextDistance = Math.hypot(dx, dy)
		if (nextDistance > Math.max(6, point.height * 0.6)) continue
		const nextArea = point.width * point.height
		if (nextDistance < distance || (nextDistance === distance && nextArea < area)) {
			closest = point
			distance = nextDistance
			area = nextArea
		}
	}
	return closest
}

/** Match compiler spans, then favor the currently viewed occurrence of reused content. */
export function pointAtSource(
	points: readonly PreviewPoint[],
	position: SourcePosition,
	page: number,
): PreviewPoint | undefined {
	let closest: PreviewPoint | undefined
	let spanSize = Infinity
	let pageDistance = Infinity
	for (const point of points) {
		if (point.path !== position.path) continue
		if (
			position.line < point.line ||
			position.line > point.endLine ||
			(position.line === point.line && position.column < point.column) ||
			(position.line === point.endLine && position.column >= point.endColumn)
		)
			continue
		const nextSpanSize = (point.endLine - point.line) * 1_000_000 + point.endColumn - point.column
		const nextPageDistance = Math.abs(point.page - page)
		if (nextSpanSize < spanSize || (nextSpanSize === spanSize && nextPageDistance < pageDistance)) {
			closest = point
			spanSize = nextSpanSize
			pageDistance = nextPageDistance
		}
	}
	return closest
}

/** Worksplit retains inactive tabs; only a visible counterpart participates. */
export function isPaneVisible(element: HTMLElement | null): boolean {
	if (!element?.isConnected) return false
	const bounds = element.getBoundingClientRect()
	if (bounds.width === 0 || bounds.height === 0) return false
	return (
		element.checkVisibility?.({ checkVisibilityCSS: true }) ?? element.getClientRects().length > 0
	)
}

import type { TypstNavigationPoint } from '../preview-contract.js'

/** Workspace-relative source path and one-based UTF-16 line and column. */
export interface SourcePosition {
	readonly path: string
	readonly line: number
	readonly column: number
}

/** Native compiler rectangles use page-local points, independent of preview zoom. */
export function pointAtPreview(
	points: readonly TypstNavigationPoint[],
	page: number,
	x: number,
	y: number,
): TypstNavigationPoint | undefined {
	let closest: TypstNavigationPoint | undefined
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

/** Match exclusive compiler spans, favoring the viewed occurrence of reused content. */
export function pointAtSource(
	points: readonly TypstNavigationPoint[],
	position: SourcePosition,
	page: number,
): TypstNavigationPoint | undefined {
	let closest: TypstNavigationPoint | undefined
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

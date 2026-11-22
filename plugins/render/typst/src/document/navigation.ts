import type { TypstPagePosition } from '../preview-contract.js'
import type {
	TypstDocumentLocation,
	TypstDocumentPoint,
	TypstDocumentPreviewData,
} from './types.js'

export interface Highlight extends TypstPagePosition {
	width: number
	height: number
	location?: TypstDocumentLocation
}

/** Accept a mapped range or its adjacent end caret; never clamp to distant content. */
export function pointAtDocumentPosition(
	preview: TypstDocumentPreviewData,
	selection: TypstDocumentLocation,
	page: number,
): Highlight | undefined {
	const destination = preview.targets.find(
		(target) =>
			target.location?.documentId === selection.documentId &&
			target.location.position === selection.position,
	)
	if (destination) return { ...destination, width: 2, height: 12 }
	let closest: TypstDocumentPoint | undefined
	for (const point of preview.points) {
		if (
			point.documentId !== selection.documentId ||
			selection.position < point.position ||
			selection.position > point.endPosition
		)
			continue
		if (
			!closest ||
			(Number(selection.position === point.endPosition) -
				Number(selection.position === closest.endPosition) ||
				point.endPosition - point.position - (closest.endPosition - closest.position) ||
				Math.abs(point.page - page) - Math.abs(closest.page - page)) < 0
		)
			closest = point
	}
	return (
		closest && {
			...closest,
			location: { documentId: closest.documentId, position: closest.position },
		}
	)
}

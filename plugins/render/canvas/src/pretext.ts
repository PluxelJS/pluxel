/**
 * Pure post-preparation helpers from Pretext.
 *
 * Text preparation stays on CanvasPlugin or a worker text adapter because it needs the
 * bounded native measurement bridge. Everything exported here operates only on an already
 * prepared immutable value and is safe to share between root and worker artifacts.
 */
export {
	layout,
	layoutNextLine,
	layoutNextLineRange,
	layoutWithLines,
	materializeLineRange,
	measureLineStats,
	measureNaturalWidth,
	walkLineRanges,
} from '@chenglou/pretext'
export {
	layoutNextRichInlineLineRange,
	materializeRichInlineLineRange,
	measureRichInlineStats,
	walkRichInlineLineRanges,
} from '@chenglou/pretext/rich-inline'

export type {
	LayoutCursor,
	LayoutLine,
	LayoutLineRange,
	LayoutLinesResult,
	LayoutResult,
	LineStats,
	PreparedText,
	PreparedTextWithSegments,
} from '@chenglou/pretext'

export type {
	PreparedRichInline,
	RichInlineCursor,
	RichInlineFragment,
	RichInlineFragmentRange,
	RichInlineLine,
	RichInlineLineRange,
	RichInlineStats,
} from '@chenglou/pretext/rich-inline'

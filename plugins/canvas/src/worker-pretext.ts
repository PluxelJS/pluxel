import {
	layout,
	layoutNextLine,
	layoutNextLineRange,
	layoutWithLines,
	materializeLineRange,
	measureLineStats,
	measureNaturalWidth,
	walkLineRanges,
} from '@chenglou/pretext'
import {
	layoutNextRichInlineLineRange,
	materializeRichInlineLineRange,
	measureRichInlineStats,
	walkRichInlineLineRanges,
} from '@chenglou/pretext/rich-inline'
import { type CanvasWorkerSnapshot, type CanvasWorkerTextLayout } from './contracts.ts'
import { CanvasTextLayoutController } from './text-layout.ts'
import { normalizeCanvasWorkerSnapshot } from './worker-internal.ts'

const textLayout = new CanvasTextLayoutController()

/** Bind bounded Pretext preparation to a detached Canvas/Fonts host snapshot. */
export function createCanvasWorkerTextLayout(
	snapshot: CanvasWorkerSnapshot,
): CanvasWorkerTextLayout {
	const normalized = normalizeCanvasWorkerSnapshot(snapshot)
	const workerTextLayout: CanvasWorkerTextLayout = {
		snapshot: normalized,
		prepareText: (input) => textLayout.prepareText(input, normalized),
		prepareTextWithSegments: (input) => textLayout.prepareTextWithSegments(input, normalized),
		prepareRichInline: (items) => textLayout.prepareRichInline(items, normalized),
	}
	return Object.freeze(workerTextLayout)
}

export {
	layout,
	layoutNextLine,
	layoutNextLineRange,
	layoutNextRichInlineLineRange,
	layoutWithLines,
	materializeLineRange,
	materializeRichInlineLineRange,
	measureLineStats,
	measureNaturalWidth,
	measureRichInlineStats,
	walkLineRanges,
	walkRichInlineLineRanges,
}
export type {
	CanvasRichInlineItem,
	CanvasTextFontInput,
	CanvasTextPreparationOptions,
	CanvasWorkerSnapshot,
	CanvasWorkerTextLayout,
	PrepareTextInput,
} from './contracts.ts'
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

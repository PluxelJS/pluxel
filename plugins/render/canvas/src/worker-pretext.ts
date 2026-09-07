import { type CanvasWorkerSnapshot, type CanvasWorkerTextLayout } from './contracts.ts'
import { CanvasTextLayoutController } from './text-layout.ts'
import { normalizeCanvasWorkerSnapshot } from './worker-internal.ts'

const textLayout = new CanvasTextLayoutController()
let lastWorkerTextLayout: CanvasWorkerTextLayout | undefined

/** Bind bounded Pretext preparation to a detached Canvas/Fonts host snapshot. */
export function createCanvasWorkerTextLayout(
	snapshot: CanvasWorkerSnapshot,
): CanvasWorkerTextLayout {
	const normalized = normalizeCanvasWorkerSnapshot(snapshot)
	if (lastWorkerTextLayout?.snapshot === normalized) return lastWorkerTextLayout
	const workerTextLayout: CanvasWorkerTextLayout = {
		snapshot: normalized,
		prepareText: (input) => textLayout.prepareText(input, normalized),
		prepareTextWithSegments: (input) => textLayout.prepareTextWithSegments(input, normalized),
		prepareRichInline: (items) => textLayout.prepareRichInline(items, normalized),
	}
	lastWorkerTextLayout = Object.freeze(workerTextLayout)
	return lastWorkerTextLayout
}

export type {
	CanvasRichInlineItem,
	CanvasTextFontInput,
	CanvasTextPreparationOptions,
	CanvasWorkerSnapshot,
	CanvasWorkerTextLayout,
	PrepareTextInput,
} from './contracts.ts'

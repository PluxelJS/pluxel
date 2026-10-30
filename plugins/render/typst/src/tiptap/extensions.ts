import { flattenExtensions, type Extensions } from '@tiptap/core'
import { createEditorExtensions } from './base-extensions.js'
import {
	TypstFigure,
	TypstFigureCaption,
	TypstBlockMath,
	TypstInlineMath,
	TypstReference,
} from './document-nodes.js'

/** Internal source schema assembly; authored files and source admission own validity. */
export function createTypstExtensions(options?: { extensions?: Extensions }): Extensions {
	const optionalBodies = flattenExtensions(options?.extensions ?? [])
		.filter((extension) => ['typstSource', 'typstComponent'].includes(extension.name))
		.map((extension) => extension.name)
	return [
		...createEditorExtensions(),
		TypstFigure.extend({
			content: `(${['image', 'table', ...optionalBodies].join(' | ')}) figureCaption`,
		}),
		TypstFigureCaption,
		TypstBlockMath,
		TypstInlineMath,
		TypstReference,
		...(options?.extensions ?? []),
	]
}

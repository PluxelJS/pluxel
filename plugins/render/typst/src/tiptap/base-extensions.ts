import type { Extensions } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { Image } from '@tiptap/extension-image'
import { TextStyleKit } from '@tiptap/extension-text-style'
import { TextAlign } from '@tiptap/extension-text-align'
import { textAlignments } from './text-align.js'

/** Official Tiptap editing only: no fields, Typst attributes, policies or serializers. */
export function createEditorExtensions(): Extensions {
	return [
		StarterKit.configure({ link: { openOnClick: false, autolink: false }, trailingNode: false }),
		TableKit.configure({ table: { resizable: true } }),
		Image.configure({ allowBase64: false }),
		TextStyleKit.configure({ lineHeight: false }),
		TextAlign.configure({
			types: ['paragraph', 'heading'],
			alignments: [...textAlignments],
			defaultAlignment: null,
		}),
	]
}

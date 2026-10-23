import type { Extensions } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { Image } from '@tiptap/extension-image'
import { TextStyleKit } from '@tiptap/extension-text-style'
import { Markdown } from '@tiptap/markdown'
import { Marked, type marked } from 'marked'

export function isolatedMarked(): typeof marked {
	// MarkdownManager uses the Lexer/defaults/use methods shared by official Marked.
	return new Marked({ gfm: true, breaks: false }) as unknown as typeof marked
}

/** Official Tiptap editing only: no fields, Typst attributes, policies or serializers. */
export function createEditorExtensions(): Extensions {
	return [
		StarterKit.configure({ link: { openOnClick: false, autolink: false }, trailingNode: false }),
		TableKit.configure({ table: { resizable: true } }),
		Image.configure({ allowBase64: false }),
		TextStyleKit.configure({ lineHeight: false }),
		Markdown.configure({ marked: isolatedMarked(), markedOptions: { gfm: true, breaks: false } }),
	]
}

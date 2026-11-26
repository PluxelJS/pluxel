import type { Editor } from '@tiptap/core'
import { createDocumentEditor, type TypstDocumentEditorOptions } from './document-editor-core.js'

export type { TypstDocumentEditorOptions } from './document-editor-core.js'
export type { TypstDocumentHistory, TypstDocumentReference } from './document-types.js'

/** A native Tiptap editor over the same chapter schema as the Typst codec. */
export function createTypstDocumentEditor(options: TypstDocumentEditorOptions): Editor {
	return createDocumentEditor(options)
}

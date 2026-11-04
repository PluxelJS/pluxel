import type { JSONContent } from '@tiptap/core'

import type { TypstDocumentSnapshot, TypstDocumentPreviewData } from '@pluxel/plugin-typst/document'

/** Only business operations and transport state belong to the example host. */
export interface DocumentView extends TypstDocumentSnapshot {
	dirty: boolean
	preview: TypstDocumentPreviewData | null
	issue?: { code: string; message: string }
}

export type DocumentRequest =
	| { action: 'open'; documentId: string }
	| { action: 'edit'; baseRevision: number; chapterId: string; document: JSONContent }
	| { action: 'create'; baseRevision: number; chapterId: string; title: string }
	| { action: 'rename'; baseRevision: number; chapterId: string; title: string }
	| { action: 'reorder'; baseRevision: number; chapterIds: string[] }
	| { action: 'undo' | 'redo' | 'save'; baseRevision: number }
	| { action: 'pdf'; revision: number }
	| { action: 'close' }

export interface DocumentFailure {
	code: string
	message: string
}

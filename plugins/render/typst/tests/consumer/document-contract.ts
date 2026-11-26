import type { JSONContent } from '@tiptap/core'

import type {
	TypstDocumentIssue,
	TypstDocumentPreviewData,
	TypstDocumentReference,
} from '@pluxel/plugin-typst/document'

export interface DocumentChapter {
	id: string
	title: string
	editable: boolean
	document: JSONContent
}

export interface DocumentProjectView {
	revision: number
	canUndo: boolean
	canRedo: boolean
	documents: readonly DocumentChapter[]
	references: readonly TypstDocumentReference[]
}

export interface DocumentView extends DocumentProjectView {
	dirty: boolean
	preview: TypstDocumentPreviewData | null
	issue?: { code: string; message: string }
}

export interface DocumentSource {
	revision: number
	source: string
}

export type DocumentEdit =
	| { kind: 'typst'; source: string }
	| { kind: 'tiptap'; document: JSONContent }

export type DocumentRequest =
	| { action: 'open'; documentId: string }
	| { action: 'source'; baseRevision: number; chapterId: string }
	| { action: 'edit'; baseRevision: number; chapterId: string; content: DocumentEdit }
	| { action: 'create'; baseRevision: number; chapterId: string; title: string }
	| { action: 'rename'; baseRevision: number; chapterId: string; title: string }
	| { action: 'reorder'; baseRevision: number; chapterIds: string[] }
	| { action: 'undo' | 'redo' | 'save'; baseRevision: number }
	| { action: 'pdf'; revision: number }
	| { action: 'close' }

export interface DocumentFailure {
	code: string
	message: string
	issues?: readonly TypstDocumentIssue[]
}

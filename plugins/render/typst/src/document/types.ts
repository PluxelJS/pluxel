import type { JSONContent } from '@tiptap/core'
import type { TypstNavigationLink, TypstPage, TypstPagePosition } from '../preview-contract.js'

/** Position in an exposed semantic document, never a source path or byte offset. */
export interface TypstDocumentLocation {
	readonly documentId: string
	readonly position: number
}

/** Opaque identity, valid for the lifetime of the document project that issued it. */
export interface TypstDocumentReference {
	readonly id: string
	readonly title: string
	readonly kind: 'heading' | 'figure' | 'table' | 'equation'
	/** Absent for a reference to fixed content outside the exposed editor documents. */
	readonly location?: TypstDocumentLocation
}

export interface TypstDocumentView {
	readonly id: string
	readonly title: string
	readonly editable: boolean
	readonly document: JSONContent
}

/** Safe to transport. Source text, paths, labels and compiler diagnostics are excluded. */
export interface TypstDocumentSnapshot {
	readonly revision: number
	readonly canUndo: boolean
	readonly canRedo: boolean
	readonly documents: readonly TypstDocumentView[]
	readonly references: readonly TypstDocumentReference[]
}

export interface TypstDocumentIssue {
	readonly code: 'CONFLICT' | 'NOT_FOUND' | 'READ_ONLY' | 'INVALID_EDIT'
	readonly message: string
}

export type TypstDocumentResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly issues: readonly TypstDocumentIssue[] }

export interface TypstDocumentPoint extends TypstDocumentLocation, TypstPagePosition {
	readonly endPosition: number
	readonly width: number
	readonly height: number
}

/** The compiler's actual labelled destination, including fixed, non-editable content. */
export interface TypstDocumentTarget extends TypstPagePosition {
	readonly id: string
	readonly location?: TypstDocumentLocation
}

export interface TypstDocumentLink extends Omit<TypstNavigationLink, 'target'> {
	readonly title: string
	readonly target:
		| (TypstPagePosition & { readonly kind: 'position'; readonly location?: TypstDocumentLocation })
		| { readonly kind: 'url'; readonly url: string }
}

/** Derived only from a compilation of this exact project revision. */
export interface TypstDocumentNavigation {
	readonly revision: number
	readonly pages: readonly TypstPage[]
	readonly points: readonly TypstDocumentPoint[]
	readonly targets: readonly TypstDocumentTarget[]
	readonly links: readonly TypstDocumentLink[]
}

/** The host supplies authenticated page-image URLs; the library owns interaction and geometry. */
export interface TypstDocumentPreviewData extends Omit<TypstDocumentNavigation, 'pages'> {
	readonly pages: readonly (TypstPage & { readonly url: string })[]
}

/** A fresh request object repeats a reveal even when the caret position is unchanged. */
export interface TypstDocumentSelection extends TypstDocumentLocation {
	readonly explicit?: boolean
}

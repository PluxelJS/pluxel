import type { TypstNavigationLink, TypstPage, TypstPagePosition } from '../preview-contract.js'

/** Position in an exposed semantic document, never a source path or byte offset. */
export interface TypstDocumentLocation {
	readonly documentId: string
	readonly position: number
}

/** A reference to a published Typst label. */
export interface TypstDocumentReference {
	readonly id: string
	readonly title: string
	readonly kind: 'heading' | 'figure' | 'table' | 'equation'
	/** Absent for a reference to fixed content outside the exposed editor documents. */
	readonly location?: TypstDocumentLocation
}

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
	/** Revision of the editor from which this position was obtained. */
	readonly revision: number
	readonly explicit?: boolean
}

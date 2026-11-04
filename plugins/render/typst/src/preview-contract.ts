/** A point on a physical page, in Typst points (1 pt = 1/72 inch). */
export interface TypstPagePosition {
	/** One-based page number. */
	readonly page: number
	readonly x: number
	readonly y: number
}

/** Source range and its rendered box, in page-local points (1 pt = 1/72 inch). */
export interface TypstNavigationPoint extends TypstPagePosition {
	/** Workspace-relative source path; generated /inputs/ files are excluded. */
	readonly path: string
	/** One-based UTF-16 positions, with an exclusive end. */
	readonly line: number
	readonly column: number
	readonly endLine: number
	readonly endColumn: number
	readonly width: number
	readonly height: number
}

export interface TypstOutlineItem extends TypstPagePosition {
	readonly title: string
	readonly level: number
}

/** A labelled element's actual layout position. Duplicate labels retain every occurrence. */
export interface TypstNavigationTarget extends TypstPagePosition {
	/** Resolved label name, without angle brackets. */
	readonly label: string
}

/** A native link's page-local bounding box and resolved destination. */
export interface TypstNavigationLink extends TypstPagePosition {
	readonly width: number
	readonly height: number
	/** URLs retain their authored scheme; the host decides which URLs may be opened. */
	readonly target:
		| (TypstPagePosition & { readonly kind: 'position' })
		| { readonly kind: 'url'; readonly url: string }
}

/** Physical page dimensions in Typst points (1 pt = 1/72 inch). */
export interface TypstPage {
	readonly page: number
	readonly width: number
	readonly height: number
}

/** Layout and source spans from the exact compilation that produced the preview. */
export interface TypstNavigation {
	readonly pages: readonly TypstPage[]
	readonly points: readonly TypstNavigationPoint[]
	readonly outline: readonly TypstOutlineItem[]
	readonly targets: readonly TypstNavigationTarget[]
	readonly links: readonly TypstNavigationLink[]
}

/** Full vector document produced by one successful compilation. */
export interface TypstPreview {
	readonly sessionId: string
	readonly revision: number
	readonly format: 'vector'
	readonly compilerVersion: '0.7.0'
	readonly data: Uint8Array
	readonly navigation: TypstNavigation
}

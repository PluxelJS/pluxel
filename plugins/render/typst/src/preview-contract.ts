/** Source range and its rendered box, in page-local points (1 pt = 1/72 inch). */
export interface TypstNavigationPoint {
	/** Workspace-relative source path; generated /inputs/ files are excluded. */
	readonly path: string
	/** One-based UTF-16 positions, with an exclusive end. */
	readonly line: number
	readonly column: number
	readonly endLine: number
	readonly endColumn: number
	/** One-based page number. */
	readonly page: number
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

export interface TypstOutlineItem {
	readonly title: string
	readonly level: number
	readonly page: number
	readonly x: number
	readonly y: number
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

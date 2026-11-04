export type { TypstDocumentReference } from '../document/types.js'

/** Optional host history. Omit it to use the editor's ordinary local undo/redo. */
export interface TypstDocumentHistory {
	readonly canUndo: boolean
	readonly canRedo: boolean
	undo(): void
	redo(): void
}

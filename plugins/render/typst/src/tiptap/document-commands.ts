// Keep the preset's native command types available from the built document entries.
import '@tiptap/starter-kit'
import '@tiptap/extension-table'
import '@tiptap/extension-image'
import '@tiptap/extension-mathematics'
import '@tiptap/extension-text-style'
import '@tiptap/extension-text-align'
import type { JSONContent } from '@tiptap/core'

declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		typstFigure: {
			insertTypstFigure: (options: {
				body: JSONContent
				caption?: JSONContent[]
				label?: string
			}) => ReturnType
			/** Wrap the block at this native position without changing its content or identity. */
			wrapTypstFigure: (position: number, caption?: JSONContent[]) => ReturnType
			duplicateTypstFigure: (position: number) => ReturnType
		}
		typstDocument: {
			insertTypstReference: (target: string) => ReturnType
			duplicateTypstBlockMath: (position: number) => ReturnType
		}
	}
}

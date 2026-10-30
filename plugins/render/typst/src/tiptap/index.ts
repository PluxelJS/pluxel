// Keep native command augmentations available to consumers of the source editor.
import '@tiptap/extension-text-style'
import '@tiptap/extension-text-align'

export { createTypstSourceEditor, type TypstSourceEditorOptions } from './source-editor.js'
export {
	TypstTableStyle,
	type TypstTableAppearance,
	type TypstTableStyleOptions,
} from './table-style.js'

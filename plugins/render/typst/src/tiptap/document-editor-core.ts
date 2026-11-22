import {
	Editor,
	Extension,
	Node,
	getSchema,
	mergeAttributes,
	type JSONContent,
	type NodeViewRenderer,
} from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { createTypstDocumentExtensions } from './document-extensions.js'
import { copyDocumentBlock, readDocument } from './document-content.js'
import { documentSync } from './editor-transactions.js'
import type { TypstDocumentHistory, TypstDocumentReference } from './document-types.js'
import './document-commands.js'

export interface TypstDocumentEditorOptions {
	content: JSONContent
	/** Omit for a headless Editor; mount it with Editor.mount or EditorContent. */
	element?: HTMLElement | null
	/** @default true */
	editable?: boolean
	references?: readonly TypstDocumentReference[]
	/** Omit for native local history. The host owns remote history and its completion state. */
	history?: TypstDocumentHistory
	/** Local edits only. Host content replacements do not call onChange. */
	onChange?(document: JSONContent): void
	onSelection?(position: number): void
}

type DocumentEditorPresentation = {
	nodeViews: Record<'figure' | 'inlineMath' | 'blockMath' | 'reference', NodeViewRenderer>
	referenceSuggestion: Extension
}

export function createDocumentEditor(
	options: TypstDocumentEditorOptions,
	presentation?: DocumentEditorPresentation,
): Editor {
	const historyAction = new PluginKey<'undo' | 'redo'>('typstDocumentHistory')
	const title = (id: unknown) =>
		options.references?.find((target) => target.id === id)?.title || '引用目标缺失'
	const extensions = createTypstDocumentExtensions().map((extension) => {
		if (extension.name === 'starterKit' && options.history)
			return extension.configure({ undoRedo: false })
		const name = extension.name
		if (name === 'reference')
			return (extension as Node).extend({
				renderHTML: ({ node, HTMLAttributes }) => [
					'span',
					mergeAttributes(HTMLAttributes, { 'data-typst-reference': node.attrs.target }),
					title(node.attrs.target),
				],
				renderText: ({ node }) => title(node.attrs.target),
				...(presentation && { addNodeView: () => presentation.nodeViews.reference }),
			})
		if (presentation && (name === 'figure' || name === 'inlineMath' || name === 'blockMath'))
			return (extension as Node).extend({ addNodeView: () => presentation.nodeViews[name] })
		return extension
	})
	if (presentation) extensions.push(presentation.referenceSuggestion)
	extensions.push(
		Extension.create({
			name: 'typstDocumentEditing',
			addCommands: () => ({
				duplicateTypstFigure:
					(position) =>
					({ editor, tr, dispatch }) =>
						editor.isEditable &&
						!editor.view.composing &&
						Number.isSafeInteger(position) &&
						position >= 0 &&
						position < tr.doc.content.size &&
						tr.doc.nodeAt(position)?.type.name === 'figure' &&
						copyDocumentBlock(tr, position, Boolean(dispatch)),
				duplicateTypstBlockMath:
					(position) =>
					({ editor, tr, dispatch }) =>
						editor.isEditable &&
						!editor.view.composing &&
						Number.isSafeInteger(position) &&
						position >= 0 &&
						position < tr.doc.content.size &&
						tr.doc.nodeAt(position)?.type.name === 'blockMath' &&
						copyDocumentBlock(tr, position, Boolean(dispatch)),
			}),
		}),
	)
	if (options.history)
		extensions.push(
			Extension.create({
				name: 'typstDocumentHistory',
				addCommands: () => ({
					undo:
						() =>
						({ editor, tr, dispatch }) => {
							if (!editor.isEditable || editor.view.composing || !options.history?.canUndo)
								return false
							if (dispatch) tr.setMeta(historyAction, 'undo')
							return true
						},
					redo:
						() =>
						({ editor, tr, dispatch }) => {
							if (!editor.isEditable || editor.view.composing || !options.history?.canRedo)
								return false
							if (dispatch) tr.setMeta(historyAction, 'redo')
							return true
						},
				}),
				onTransaction({ transaction }) {
					const action = transaction.getMeta(historyAction) as 'undo' | 'redo' | undefined
					if (action) options.history?.[action]()
				},
				addKeyboardShortcuts() {
					return {
						'Mod-z': () => this.editor.commands.undo(),
						'Mod-Shift-z': () => this.editor.commands.redo(),
						'Mod-y': () => this.editor.commands.redo(),
					}
				},
			}),
		)
	const content = readDocument(getSchema(extensions), options.content).toJSON()
	const editor = new Editor({
		element: null,
		content,
		extensions,
		editable: options.editable !== false,
		editorProps: {
			attributes: { role: 'textbox', 'aria-label': '文档正文', 'aria-multiline': 'true' },
		},
		onUpdate({ editor: current, transaction }) {
			if (!transaction.getMeta(documentSync)) options.onChange?.(current.getJSON())
		},
		onSelectionUpdate({ editor: current }) {
			options.onSelection?.(current.state.selection.from)
		},
	})
	// Headless Editor still needs the same native admission/history plugins as a mounted view.
	editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }))
	if (options.element) editor.mount(options.element)
	return editor
}

import {
	Editor,
	Extension,
	Node,
	getSchema,
	mergeAttributes,
	type Extensions,
	type JSONContent,
} from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { createTypstExtensions } from './extensions.js'
import { TypstTableStyle } from './table-style.js'
import {
	copyDocumentBlock,
	preservesDocumentPlaceholders,
	readDocument,
} from './document-content.js'
import { documentSync } from './editor-transactions.js'
import type { TypstDocumentHistory, TypstDocumentReference } from './document-types.js'
import './document-commands.js'

export type { TypstDocumentHistory, TypstDocumentReference } from './document-types.js'

export interface TypstDocumentEditorOptions {
	content: JSONContent
	/** Omit for a headless Editor; mount it with Editor.mount or EditorContent. */
	element?: HTMLElement | null
	/** @default true */
	editable?: boolean
	references?: readonly TypstDocumentReference[]
	/** Omit for native local history. The host owns remote history and its completion state. */
	history?: TypstDocumentHistory
	/** Additional native extensions; extensions with the same name replace preset views/options. */
	extensions?: Extensions
	/** Local edits only. Host content replacements do not call onChange. */
	onChange?(document: JSONContent): void
	onSelection?(position: number): void
}

function placeholder(inline: boolean) {
	const name = inline ? 'documentInline' : 'documentBlock'
	return Node.create({
		name,
		group: inline ? 'inline' : 'block',
		inline,
		atom: true,
		selectable: false,
		marks: '',
		addAttributes: () => ({
			key: { default: null },
			title: { default: '固定内容' },
		}),
		parseHTML: () => [{ tag: `${inline ? 'span' : 'div'}[data-document-fixed]` }],
		renderHTML: ({ node }) => [
			inline ? 'span' : 'div',
			{
				'data-document-fixed': node.attrs.key,
				class: inline ? 'typst-document-inline' : 'typst-document-block typst-source-card',
				contenteditable: 'false',
				title: '由文档管理的固定内容',
			},
			node.attrs.title,
		],
		renderText: ({ node }) => node.attrs.title,
		renderMarkdown: (node) => node.attrs?.title ?? '固定内容',
	})
}

/** A native Tiptap editor over semantic JSON only. It never opens or assembles a Typst project. */
export function createTypstDocumentEditor(options: TypstDocumentEditorOptions): Editor {
	const historyAction = new PluginKey<'undo' | 'redo'>('typstDocumentHistory')
	const replacements = new Map(options.extensions?.map((extension) => [extension.name, extension]))
	const title = (id: unknown) =>
		options.references?.find((target) => target.id === id)?.title || '引用目标缺失'
	const extensions = createTypstExtensions({
		extensions: [placeholder(false), placeholder(true), TypstTableStyle],
	}).map((extension) => {
		let current = replacements.get(extension.name) ?? extension
		if (current.name === 'starterKit' && options.history)
			return current.configure({ undoRedo: false })
		if (current.name === 'figure')
			current = (current as Node).extend({
				content: '(image | table | documentBlock) figureCaption',
				addAttributes: () => ({ id: { default: null } }),
			})
		if (current.name === 'blockMath')
			current = (current as Node).extend({
				addAttributes() {
					const { label: _label, ...attributes } = this.parent?.() ?? {}
					return attributes
				},
			})
		if (current.name === 'reference')
			current = (current as Node).extend({
				renderHTML: ({ node, HTMLAttributes }) => [
					'span',
					mergeAttributes(HTMLAttributes, { 'data-typst-reference': node.attrs.target }),
					title(node.attrs.target),
				],
				renderText: ({ node }) => title(node.attrs.target),
				renderMarkdown: (node) => title(node.attrs?.target),
				addCommands() {
					return {
						insertTypstReference:
							(target) =>
							({ editor, commands }) =>
								editor.isEditable &&
								!editor.view.composing &&
								typeof target === 'string' &&
								Boolean(target) &&
								target.isWellFormed() &&
								commands.insertContent({ type: this.name, attrs: { target } }),
					}
				},
			})
		return current
	})
	const names = new Set(extensions.map((extension) => extension.name))
	extensions.push(...(options.extensions ?? []).filter((extension) => !names.has(extension.name)))
	extensions.push(
		Extension.create({
			name: 'typstDocumentEditing',
			addGlobalAttributes: () => [{ types: ['heading'], attributes: { id: { default: null } } }],
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
			addProseMirrorPlugins: () => [
				new Plugin({
					filterTransaction: (transaction, state) =>
						!transaction.docChanged ||
						transaction.getMeta(documentSync) ||
						preservesDocumentPlaceholders(state.doc, transaction.doc),
				}),
			],
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

import { Editor, Extension, Node, type EditorOptions, type Extensions } from '@tiptap/core'
import { Plugin, PluginKey, Selection, type Transaction } from '@tiptap/pm/state'
import type { TypstSourceProject } from '../source/state-types.js'
import { TypstSourceProjectError } from '../source/project-state.js'
import type { TypstSourceDiagnostic, TypstSourceProjection } from '../source/types.js'
import { createTypstExtensions } from './extensions.js'
import { validReferenceLabel } from './document-nodes.js'
import { TypstTableStyle } from './table-style.js'

/** Internal projection event; UI can distinguish normalization of its own edit from external edits. */
export const sourceSync = new PluginKey<{ local: boolean }>('typstSourceSync')
const sourceHistory = 'typstSourceHistory'
const sourceCopy = new PluginKey<unknown>('typstSourceCopy')
type CopyInput = Parameters<TypstSourceProject['copy']>[0]

/** Clipboard HTML carries a derived node only; source admission verifies it again on paste. */
function sourceHTMLAttributes(element: HTMLElement): Record<string, unknown> | undefined {
	const value = element.getAttribute('data-typst-attrs')
	if (value === null) return undefined
	try {
		const attributes: unknown = JSON.parse(value)
		return attributes && typeof attributes === 'object' && !Array.isArray(attributes)
			? (attributes as Record<string, unknown>)
			: undefined
	} catch {
		return undefined
	}
}

/** Internal UI adapter. Copying uses source ranges and project history, preserving call parameters. */
export function prepareTypstSourceCopy(
	editor: Editor,
	project: TypstSourceProject,
	path: string,
	position: number,
): Transaction | undefined {
	if (!editor.isEditable || editor.view.composing) return undefined
	const projection = project.open(path)
	if (!editor.schema.nodeFromJSON(projection.document).eq(editor.state.doc)) return undefined
	const node = editor.state.doc.nodeAt(position)
	if (!node || node.type.name === 'typstSource') return undefined
	const mapping = projection.mapping.find(
		(value) => value.kind === 'node' && value.nodePath.length === 1 && value.position === position,
	)
	if (!mapping || mapping.from === mapping.to) return undefined
	const input: CopyInput = {
		baseRevision: project.revision,
		path,
		from: mapping.from,
		to: mapping.to,
		toPath: path,
		at: mapping.to,
	}
	return editor.state.tr.setMeta(sourceCopy, input).setMeta('addToHistory', false)
}

/** Opaque source remains at its actual inline position; it is never a display-code replacement. */
export const TypstInlineSource = Node.create({
	name: 'typstInlineSource',
	group: 'inline',
	inline: true,
	atom: true,
	addAttributes: () => ({ source: { default: '' }, role: { default: 'expression' } }),
	parseHTML: () => [
		{
			tag: 'span[data-typst-inline-source]',
			priority: 100,
			getAttrs: (element) => {
				const attrs = sourceHTMLAttributes(element)
				return attrs && typeof attrs.source === 'string' && typeof attrs.role === 'string'
					? attrs
					: { source: element.textContent ?? '', role: 'expression' }
			},
		},
	],
	renderHTML: ({ node }) => [
		'span',
		{
			'data-typst-inline-source': '',
			'data-typst-attrs': JSON.stringify(node.attrs),
			class: 'typst-inline-source',
			title: 'Typst 源码',
		},
		node.attrs.source,
	],
	renderText: ({ node }) => node.attrs.source,
})

export const TypstSourceBlock = Node.create({
	name: 'typstSource',
	group: 'block',
	atom: true,
	isolating: true,
	addAttributes: () => ({ source: { default: '' }, role: { default: 'block' } }),
	parseHTML: () => [
		{
			tag: 'pre[data-typst-source]',
			priority: 100,
			getAttrs: (element) => {
				const attrs = sourceHTMLAttributes(element)
				return attrs && typeof attrs.source === 'string' && typeof attrs.role === 'string'
					? attrs
					: { source: element.textContent ?? '', role: 'block' }
			},
		},
	],
	renderHTML: ({ node }) => [
		'pre',
		{
			'data-typst-source': '',
			'data-typst-attrs': JSON.stringify(node.attrs),
			class: 'typst-source-block',
		},
		['code', {}, node.attrs.source],
	],
})

/** Template arguments are literal source parameters; bound data stays in its JSON file. */
export const TypstComponent = Node.create({
	name: 'typstComponent',
	group: 'block',
	atom: true,
	isolating: true,
	addAttributes: () =>
		Object.fromEntries(
			['module', 'name', 'label', 'parameters', 'props', 'binding', 'source'].map((name) => [
				name,
				{ default: null },
			]),
		),
	parseHTML: () => [
		{
			tag: 'div[data-typst-component]',
			priority: 100,
			getAttrs: (element) => {
				const attrs = sourceHTMLAttributes(element)
				return attrs &&
					typeof attrs.module === 'string' &&
					typeof attrs.name === 'string' &&
					typeof attrs.source === 'string'
					? attrs
					: false
			},
		},
	],
	renderHTML: ({ node }) => [
		'div',
		{ 'data-typst-component': '', 'data-typst-attrs': JSON.stringify(node.attrs) },
		node.attrs.label ?? node.attrs.name,
	],
})
export const TypstField = Node.create({
	name: 'typstField',
	group: 'inline',
	inline: true,
	atom: true,
	addAttributes: () => ({ file: { default: '' }, path: { default: [] }, source: { default: '' } }),
	parseHTML: () => [
		{
			tag: 'span[data-typst-field]',
			priority: 100,
			getAttrs: (element) => {
				const attrs = sourceHTMLAttributes(element)
				return attrs &&
					typeof attrs.file === 'string' &&
					typeof attrs.source === 'string' &&
					Array.isArray(attrs.path) &&
					attrs.path.every(
						(key) =>
							typeof key === 'string' || (typeof key === 'number' && Number.isSafeInteger(key)),
					)
					? attrs
					: false
			},
		},
	],
	renderHTML: ({ node }) => [
		'span',
		{ 'data-typst-field': '', 'data-typst-attrs': JSON.stringify(node.attrs) },
		`${node.attrs.file}: ${node.attrs.path.join('.')}`,
	],
})

export interface TypstSourceEditorOptions {
	project: TypstSourceProject
	path: string
	/** Omit for a real headless Editor. Mount it later using Editor.mount/EditorContent. */
	element?: HTMLElement | null
	editable?: boolean
	/** NodeView/custom extension replacements by name; source admission always remains installed. */
	extensions?: Extensions
	onIssues?(issues: readonly TypstSourceDiagnostic[]): void
	onSelectionUpdate?: EditorOptions['onSelectionUpdate']
}

/** A native Tiptap Editor whose accepted changes update the authoritative source project. */
export function createTypstSourceEditor(options: TypstSourceEditorOptions): Editor {
	const { project, path } = options
	let projection = project.open(path)
	let committing = false
	let syncing = false
	let synchronization: Transaction | undefined
	let unavailable = false
	let disposed = false
	let editor: Editor
	const report = (issues: readonly TypstSourceDiagnostic[]) => options.onIssues?.(issues)
	const issue = (message: string): TypstSourceDiagnostic => ({
		code: 'INVALID_EDIT',
		path,
		revision: project.revision,
		from: 0,
		to: 0,
		severity: 'error',
		message,
	})
	const sourceAttributes = Extension.create({
		name: 'typstSourceAttributes',
		addGlobalAttributes: () => [{ types: ['heading'], attributes: { label: { default: null } } }],
		addCommands: () => ({
			insertTypstReference:
				(target: string) =>
				({ commands }) =>
					editor.isEditable &&
					!editor.view.composing &&
					validReferenceLabel(target) &&
					commands.insertContent({ type: 'reference', attrs: { target, showCaption: null } }),
			duplicateTypstFigure:
				(position: number) =>
				({ tr, dispatch }) => {
					if (tr.doc.nodeAt(position)?.type.name !== 'figure') return false
					const prepared = prepareTypstSourceCopy(editor, project, path, position)
					if (!prepared) return false
					if (dispatch) tr.setMeta(sourceCopy, prepared.getMeta(sourceCopy))
					return true
				},
			duplicateTypstBlockMath:
				(position: number) =>
				({ tr, dispatch }) => {
					if (tr.doc.nodeAt(position)?.type.name !== 'blockMath') return false
					const prepared = prepareTypstSourceCopy(editor, project, path, position)
					if (!prepared) return false
					if (dispatch) tr.setMeta(sourceCopy, prepared.getMeta(sourceCopy))
					return true
				},
		}),
	})
	const history = Extension.create({
		name: sourceHistory,
		addCommands: () => ({
			undo:
				() =>
				({ tr, dispatch }) => {
					if (!editor.isEditable || unavailable || !project.canUndo) return false
					if (dispatch) tr.setMeta(sourceHistory, 'undo')
					return true
				},
			redo:
				() =>
				({ tr, dispatch }) => {
					if (!editor.isEditable || unavailable || !project.canRedo) return false
					if (dispatch) tr.setMeta(sourceHistory, 'redo')
					return true
				},
		}),
		addKeyboardShortcuts() {
			return {
				'Mod-z': () => this.editor.commands.undo(),
				'Mod-Shift-z': () => this.editor.commands.redo(),
				'Mod-y': () => this.editor.commands.redo(),
			}
		},
	})
	const admission = Extension.create({
		name: 'typstSourceAdmission',
		addProseMirrorPlugins: () => [
			new Plugin({
				key: sourceSync,
				filterTransaction(transaction, state) {
					if (transaction === synchronization) return true
					if (
						!transaction.docChanged &&
						!transaction.getMeta(sourceHistory) &&
						!transaction.getMeta(sourceCopy)
					)
						return true
					if (syncing || unavailable) {
						report([
							issue(
								'The source projection is being replaced or could not be synchronized. Reopen this source view before editing.',
							),
						])
						return false
					}
					if (!transaction.before.eq(state.doc)) {
						report([
							{
								...issue('The editor transaction belongs to an older source projection.'),
								code: 'CONFLICT',
							},
						])
						return false
					}
					if (!editor.isEditable) {
						report([issue('This source view is read-only.')])
						return false
					}
					const copy = transaction.getMeta(sourceCopy) as CopyInput | undefined
					if (copy) {
						const current = projection.mapping.find(
							(value) =>
								value.kind === 'node' &&
								value.nodePath.length === 1 &&
								value.from === copy.from &&
								value.to === copy.to,
						)
						if (
							transaction.docChanged ||
							copy.baseRevision !== project.revision ||
							copy.path !== path ||
							copy.toPath !== path ||
							copy.at !== copy.to ||
							!current
						) {
							report([
								{
									...issue(
										'The copy request belongs to an older source range or was combined with another edit.',
									),
									code: 'CONFLICT',
								},
							])
							return false
						}
					}
					if (!transaction.docChanged) return true
					const prepared = project.prepareEdit({ projection, document: transaction.doc.toJSON() })
					if (!prepared.ok) report(prepared.issues)
					return prepared.ok
				},
			}),
		],
	})
	const replacements = new Map(options.extensions?.map((extension) => [extension.name, extension]))
	const extensions = createTypstExtensions({
		extensions: [TypstSourceBlock, TypstInlineSource, TypstComponent, TypstField, TypstTableStyle],
	}).map((extension) => {
		if (extension.name === 'starterKit') return extension.configure({ undoRedo: false })
		return replacements.get(extension.name) ?? extension
	})
	const names = new Set(extensions.map((extension) => extension.name))
	extensions.push(
		...(options.extensions ?? []).filter((extension) => !names.has(extension.name)),
		history,
		sourceAttributes,
		admission,
	)

	function refresh(local = false) {
		if (committing || !editor || disposed) return
		let current: TypstSourceProjection
		try {
			current = project.open(path)
		} catch (error) {
			unavailable = true
			report([
				{
					...issue(error instanceof Error ? error.message : String(error)),
					...(error instanceof TypstSourceProjectError ? { code: error.code } : {}),
				},
			])
			return
		}
		const document = editor.schema.nodeFromJSON(current.document)
		document.check()
		if (document.eq(editor.state.doc)) {
			projection = current
			unavailable = false
			return
		}
		syncing = true
		try {
			const at = Math.min(editor.state.selection.from, document.content.size)
			const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, document.content)
			if (local) {
				try {
					tr.setSelection(Selection.fromJSON(tr.doc, editor.state.selection.toJSON()))
					tr.setStoredMarks(editor.state.storedMarks)
				} catch {
					tr.setSelection(Selection.near(tr.doc.resolve(at)))
				}
			} else tr.setSelection(Selection.near(tr.doc.resolve(at)))
			tr.setMeta(sourceSync, { local }).setMeta('addToHistory', false)
			synchronization = tr
			editor.view.dispatch(tr)
			if (editor.state.doc.eq(document)) {
				projection = current
				unavailable = false
			} else {
				unavailable = true
				report([
					issue(
						'An editor extension rejected the current source projection. Source was retained; reopen this view before editing.',
					),
				])
			}
		} finally {
			syncing = false
			synchronization = undefined
		}
	}

	editor = new Editor({
		element: null,
		editorProps: {
			attributes: {
				role: 'textbox',
				'aria-label': `Typst 源文件 ${path}`,
				'aria-multiline': 'true',
			},
		},
		extensions,
		content: projection.document,
		editable: options.editable ?? true,
		enableContentCheck: true,
		...(options.onSelectionUpdate ? { onSelectionUpdate: options.onSelectionUpdate } : {}),
		onTransaction({ transaction, appendedTransactions }) {
			if (syncing || transaction === synchronization) return
			const copy = transaction.getMeta(sourceCopy) as CopyInput | undefined
			if (copy) {
				const result = project.copy(copy)
				report(result.ok ? [] : result.issues)
				return
			}
			const action = transaction.getMeta(sourceHistory) as 'undo' | 'redo' | undefined
			if (action) {
				const result = project[action]()
				report(result.ok ? [] : result.issues)
				return
			}
			if (!transaction.docChanged && !appendedTransactions.some((value) => value.docChanged)) return
			committing = true
			let accepted = false
			try {
				const result = project.edit({ projection, document: editor.getJSON() })
				accepted = result.ok
				report(result.ok ? [] : result.issues)
			} finally {
				committing = false
			}
			// Reproject accepted source. Rejected appended edits are visibly reported and restored.
			refresh(accepted)
		},
	})
	// Tiptap installs extension plugins when mounted. Headless editing needs the same admission.
	editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }))
	const unsubscribe = project.subscribe(refresh)
	editor.on('destroy', () => {
		disposed = true
		unsubscribe()
	})
	if (options.element) editor.mount(options.element)
	return editor
}

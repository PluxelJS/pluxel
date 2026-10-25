import { Editor, type JSONContent } from '@tiptap/core'
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state'
import { history, redo, undo } from '@tiptap/pm/history'
import { describe, expect, it, vi } from 'vitest'
import {
	createTypstExtensions,
	TypstSource,
	TypstTemplateBlock,
	type TypstEditorConfig,
} from '../src/tiptap/index'
import type { EditorUiContext } from '../src/tiptap/editor-ui'
import {
	captureBlockTarget,
	prepareBlockAction,
	type BlockAction,
} from '../src/tiptap/block-actions'
import { convertBlock, insertEntries, prepareInsertion } from '../src/tiptap/insert-commands'

const text = (value: string): JSONContent => ({ type: 'text', text: value })
const paragraph = (value: string): JSONContent => ({ type: 'paragraph', content: [text(value)] })
const list = (...items: string[]): JSONContent => ({
	type: 'bulletList',
	content: items.map((value) => ({ type: 'listItem', content: [paragraph(value)] })),
})
const table = (content: JSONContent[]): JSONContent => ({
	type: 'table',
	content: [{ type: 'tableRow', content: [{ type: 'tableCell', content }] }],
})
const source: JSONContent = {
	type: 'typstSource',
	attrs: { id: 'source-original', source: '#text[Original]' },
}
const template: JSONContent = {
	type: 'templateBlock',
	attrs: {
		id: 'template-original',
		template: 'summary',
		props: { title: 'Original', nested: [1, 2] },
		dataPath: ['customer'],
	},
}
const config: TypstEditorConfig = {
	regions: [{ id: 'body' }],
	fields: [{ path: ['customer'], label: '客户' }],
	extensions: [
		TypstSource,
		TypstTemplateBlock.configure({
			templates: [
				{ id: 'summary', label: '摘要', source: '#props.title', defaults: { title: 'Default' } },
			],
		}),
	],
}
function context(rules = config): EditorUiContext {
	return {
		config: rules,
		region: rules.regions[0],
		editable: true,
		composing: false,
		fontFamilies: [],
		slashCommands: [],
	}
}
function createEditor(content: JSONContent[], rules = config) {
	const editor = new Editor({
		element: null,
		extensions: createTypstExtensions(rules),
		content: { type: 'doc', content },
	})
	const admission = vi.fn(() => true)
	editor.view.updateState(
		editor.state.reconfigure({
			plugins: [history(), new Plugin({ filterTransaction: admission })],
		}),
	)
	return { editor, admission }
}
function positions(editor: Editor) {
	const result: number[] = []
	editor.state.doc.forEach((_node, at) => result.push(at))
	return result
}
function apply(editor: Editor, index: number, action: BlockAction, ui = context()) {
	const target = captureBlockTarget(editor, positions(editor)[index])!
	const prepared = prepareBlockAction(editor, ui, target, action)
	expect(prepared).toBeDefined()
	editor.view.dispatch(prepared!)
}
function expectUndoRedo(editor: Editor, before: JSONContent, after: JSONContent) {
	expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
	expect(editor.getJSON()).toEqual(before)
	expect(redo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
	expect(editor.getJSON()).toEqual(after)
}

describe('explicit native block actions', () => {
	it('captures whole top-level tables/lists and rejects ambiguous or separately owned targets', () => {
		const { editor } = createEditor([
			paragraph('Before'),
			list('One', 'Two'),
			table([paragraph('Cell')]),
			source,
		])
		try {
			const at = positions(editor)
			for (const [index, offset] of [
				[1, 3],
				[2, 4],
			]) {
				editor.commands.setTextSelection(at[index] + offset)
				const target = captureBlockTarget(editor)!
				expect(target.pos).toBe(at[index])
				expect(target.node).toBe(editor.state.doc.child(index))
			}
			editor.commands.setTextSelection({ from: 1, to: at[1] + 4 })
			expect(captureBlockTarget(editor)).toBeUndefined()
			expect(captureBlockTarget(editor, at[3])).toBeUndefined()
			expect(captureBlockTarget(editor, editor.state.doc.content.size)).toBeUndefined()
		} finally {
			editor.destroy()
		}
	})

	it('moves, copies and deletes a whole list with isolated history and no preflight dispatch', () => {
		for (const action of ['moveUp', 'moveDown', 'duplicate', 'delete'] as const) {
			const { editor, admission } = createEditor([
				paragraph('Before'),
				list('One', 'Two'),
				paragraph('After'),
			])
			try {
				const before = editor.getJSON()
				const target = captureBlockTarget(editor, positions(editor)[1])!
				const state = editor.state
				const prepared = prepareBlockAction(editor, context(), target, action)!
				expect(prepared).toBeDefined()
				expect(editor.state).toBe(state)
				expect(admission).not.toHaveBeenCalled()
				expect(undo(editor.state)).toBe(false)
				editor.view.dispatch(prepared)
				const after = editor.getJSON()
				const original = before.content![1]
				const expected = {
					moveUp: [original, before.content![0], before.content![2]],
					moveDown: [before.content![0], before.content![2], original],
					duplicate: [before.content![0], original, original, before.content![2]],
					delete: [before.content![0], before.content![2]],
				}
				expect(after.content).toEqual(expected[action])
				expect(editor.state.selection).toBeInstanceOf(
					action === 'delete' ? TextSelection : NodeSelection,
				)
				expectUndoRedo(editor, before, after)
			} finally {
				editor.destroy()
			}
		}
	})

	it('converts complete simple paragraphs and lists without changing neighboring blocks or inline content', () => {
		const inline: JSONContent = {
			type: 'paragraph',
			content: [
				{ type: 'text', text: 'Important ', marks: [{ type: 'bold' }] },
				{ type: 'dataField', attrs: { path: ['customer'] } },
			],
		}
		const { editor } = createEditor([paragraph('Before'), inline, paragraph('After')])
		try {
			for (const block of [
				'bulletList',
				'orderedList',
				'paragraph',
				'heading-2',
				'blockquote',
				'paragraph',
			] as const) {
				const before = editor.getJSON()
				apply(editor, 1, { type: 'convert', block })
				const after = editor.getJSON()
				expect(after.content![0]).toEqual(before.content![0])
				expect(after.content!.at(-1)).toEqual(before.content!.at(-1))
				const markText: JSONContent[] = []
				const fields: JSONContent[] = []
				editor.state.doc.child(1).descendants((node) => {
					if (node.isText) markText.push(node.toJSON())
					if (node.type.name === 'dataField') fields.push(node.toJSON())
				})
				expect(markText).toEqual([inline.content![0]])
				expect(fields).toEqual([{ type: 'dataField', attrs: { path: ['customer'] } }])
				expect(editor.state.selection).toBeInstanceOf(TextSelection)
				expectUndoRedo(editor, before, after)
			}
		} finally {
			editor.destroy()
		}
		const { editor: multi } = createEditor([
			paragraph('Before'),
			list('One', 'Two'),
			paragraph('After'),
		])
		try {
			const before = multi.getJSON()
			apply(multi, 1, { type: 'convert', block: 'paragraph' })
			const after = multi.getJSON()
			expect(after.content!.map((node) => node.type)).toEqual([
				'paragraph',
				'paragraph',
				'paragraph',
				'paragraph',
			])
			expect(multi.state.doc.textContent).toBe('BeforeOneTwoAfter')
			expectUndoRedo(multi, before, after)
		} finally {
			multi.destroy()
		}
	})

	it('copies nested Typst atoms with new identities and independent props while moves preserve identities', () => {
		const { editor } = createEditor([
			table([paragraph('Cell'), template, source]),
			paragraph('After'),
		])
		try {
			const before: JSONContent = editor.getJSON()
			apply(editor, 0, 'duplicate')
			const after: JSONContent = editor.getJSON()
			const copied = after.content![1].content![0].content![0].content!
			const original = before.content![0].content![0].content![0].content!
			for (let i = 1; i < 3; i++) {
				expect(copied[i].attrs!.id).not.toBe(original[i].attrs!.id)
				expect({ ...copied[i].attrs, id: '' }).toEqual({ ...original[i].attrs, id: '' })
			}
			expect(copied[1].attrs!.id).not.toBe(copied[2].attrs!.id)
			expect(copied[1].attrs!.props).not.toBe(
				editor.state.doc.child(0).child(0).child(0).child(1).attrs.props,
			)
			expectUndoRedo(editor, before, after)
			apply(editor, 1, 'moveDown')
			expect(editor.getJSON().content!.at(-1)).toEqual(after.content![1])
		} finally {
			editor.destroy()
		}
	})

	it('converts a complete multi-item list and makes code formatting loss explicit and reversible', () => {
		for (const block of ['orderedList', 'heading-2', 'blockquote'] as const) {
			const { editor } = createEditor([paragraph('Before'), list('One', 'Two'), paragraph('After')])
			try {
				const before = editor.getJSON()
				apply(editor, 1, { type: 'convert', block })
				const after = editor.getJSON()
				expect(editor.state.doc.textContent).toBe('BeforeOneTwoAfter')
				expect(after.content![0]).toEqual(before.content![0])
				expect(after.content!.at(-1)).toEqual(before.content!.at(-1))
				expect(after.content![1].type).toBe(block === 'heading-2' ? 'heading' : block)
				expectUndoRedo(editor, before, after)
			} finally {
				editor.destroy()
			}
		}
		const marked: JSONContent = {
			type: 'paragraph',
			content: [{ type: 'text', text: 'Keep the code text', marks: [{ type: 'bold' }] }],
		}
		const { editor } = createEditor([marked])
		try {
			const before = editor.getJSON()
			apply(editor, 0, { type: 'convert', block: 'codeBlock' })
			const code = editor.getJSON()
			expect(code.content![0].type).toBe('codeBlock')
			expect(code.content![0].content).toEqual([text('Keep the code text')])
			expectUndoRedo(editor, before, code)
			apply(editor, 0, { type: 'convert', block: 'paragraph' })
			expect(editor.getJSON().content![0].type).toBe('paragraph')
			expect(editor.state.doc.textContent).toBe('Keep the code text')
		} finally {
			editor.destroy()
		}
	})

	it('disables moves beyond document edges and deletes the final block with native empty-document behavior', () => {
		const { editor } = createEditor([list('Only item')])
		try {
			const before = editor.getJSON()
			const target = captureBlockTarget(editor, 0)!
			expect(prepareBlockAction(editor, context(), target, 'moveUp')).toBeUndefined()
			expect(prepareBlockAction(editor, context(), target, 'moveDown')).toBeUndefined()
			apply(editor, 0, 'delete')
			const after = editor.getJSON()
			expect(after.content!.map((node) => node.type)).toEqual(['paragraph'])
			expect(editor.state.doc.textContent).toBe('')
			expectUndoRedo(editor, before, after)
		} finally {
			editor.destroy()
		}
	})

	it('rejects code conversion from the shared format command before lifting a quote or losing a field', () => {
		const { editor } = createEditor([
			{
				type: 'blockquote',
				content: [
					{
						type: 'paragraph',
						content: [text('Keep '), { type: 'dataField', attrs: { path: ['customer'] } }],
					},
				],
			},
		])
		try {
			editor.commands.setTextSelection(3)
			const before = editor.getJSON()
			expect(convertBlock(editor.can().chain(), 'codeBlock').run()).toBe(false)
			expect(convertBlock(editor.chain(), 'codeBlock').run()).toBe(false)
			expect(editor.getJSON()).toEqual(before)
			expect(undo(editor.state)).toBe(false)
		} finally {
			editor.destroy()
		}
	})

	it('refuses lossy conversion, invalid source identities, permission changes and stale document targets', () => {
		const nested = list('Outer')
		nested.content![0].content!.push(list('Nested'))
		const field: JSONContent = {
			type: 'paragraph',
			content: [{ type: 'dataField', attrs: { path: ['customer'] } }],
		}
		const { editor } = createEditor([nested, table([paragraph('Cell')]), field])
		try {
			const before = editor.getJSON()
			for (const index of [0, 1])
				expect(
					prepareBlockAction(
						editor,
						context(),
						captureBlockTarget(editor, positions(editor)[index])!,
						{ type: 'convert', block: 'paragraph' },
					),
				).toBeUndefined()
			expect(
				prepareBlockAction(editor, context(), captureBlockTarget(editor, positions(editor)[2])!, {
					type: 'convert',
					block: 'codeBlock',
				}),
			).toBeUndefined()
			const target = captureBlockTarget(editor, 0)!
			for (const ui of [
				{ ...context(), editable: false },
				{ ...context(), composing: true },
			])
				expect(prepareBlockAction(editor, ui, target, 'duplicate')).toBeUndefined()
			editor.commands.setTextSelection(3)
			expect(prepareBlockAction(editor, context(), target, 'duplicate')).toBeDefined()
			expect(editor.getJSON()).toEqual(before)
			editor.view.dispatch(editor.state.tr.insertText('Changed', 3))
			expect(prepareBlockAction(editor, context(), target, 'delete')).toBeUndefined()
		} finally {
			editor.destroy()
		}
		const invalid = { ...template, attrs: { ...template.attrs, id: 'invalid/id' } }
		const { editor: bad } = createEditor([table([paragraph('Cell'), invalid])])
		try {
			expect(
				prepareBlockAction(bad, context(), captureBlockTarget(bad, 0)!, 'duplicate'),
			).toBeUndefined()
		} finally {
			bad.destroy()
		}
	})

	it('inserts every catalog action at its frozen boundary in one transaction, independently of the old caret', () => {
		const content: JSONContent[] = [
			{ type: 'blockquote', content: [paragraph('Caret stays here')] },
			paragraph('Target'),
			paragraph('After'),
		]
		const { editor: catalog } = createEditor(content)
		const ids = insertEntries(catalog, context()).map((entry) => entry.id)
		catalog.destroy()
		for (const id of ids) {
			const { editor, admission } = createEditor(content)
			try {
				editor.commands.setTextSelection(3)
				admission.mockClear()
				const before = editor.getJSON()
				const local = { at: positions(editor)[2], doc: editor.state.doc }
				const entry = insertEntries(editor, context(), local).find((item) => item.id === id)!
				const tr = prepareInsertion(editor, context(), entry, local)
				expect({ id, prepared: Boolean(tr) }).toEqual({ id, prepared: true })
				expect(admission).not.toHaveBeenCalled()
				expect(editor.getJSON()).toEqual(before)
				editor.view.dispatch(tr!)
				const after = editor.getJSON()
				expect(after.content!.slice(0, 2)).toEqual(before.content!.slice(0, 2))
				expect(after.content!.at(-1)).toEqual(before.content!.at(-1))
				expect(after.content!.length).toBeGreaterThan(before.content!.length)
				expectUndoRedo(editor, before, after)
				expect(prepareInsertion(editor, context(), entry, local)).toBeUndefined()
			} finally {
				editor.destroy()
			}
		}
	})
})

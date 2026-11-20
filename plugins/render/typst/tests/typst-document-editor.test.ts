import { describe, expect, it, vi } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { createTypstDocumentEditor } from '../src/tiptap/document-editor.js'
import { TypstDocumentEditor } from '../src/tiptap/document-editor-react.js'
import { synchronizeDocument } from '../src/tiptap/document-content.js'

// A semantic editor, including its shared React tools, must not load either source owner.
vi.mock('../src/source/project-state.js', () => {
	throw new Error('Loaded a source project')
})
vi.mock('../src/source/parse.js', () => {
	throw new Error('Loaded the source parser')
})

const paragraph = (text: string): JSONContent => ({
	type: 'paragraph',
	content: [{ type: 'text', text }],
})
const document = (text: string): JSONContent => ({ type: 'doc', content: [paragraph(text)] })

describe('semantic document editor', () => {
	it('shares native rich-text editing and local history without a source project', () => {
		expect(typeof TypstDocumentEditor).toBe('function')
		const changed = vi.fn()
		const editor = createTypstDocumentEditor({ content: document('正文'), onChange: changed })
		try {
			expect(editor.commands.insertContentAt(1, { type: 'text', text: '更新：' })).toBe(true)
			expect(editor.getText()).toBe('更新：正文')
			expect(changed).toHaveBeenLastCalledWith(editor.getJSON())
			expect(editor.commands.undo()).toBe(true)
			expect(editor.getText()).toBe('正文')
			expect(editor.commands.redo()).toBe(true)
			expect(editor.getText()).toBe('更新：正文')
			editor.commands.setTextSelection({ from: 1, to: 3 })
			expect(editor.commands.toggleBold()).toBe(true)
			expect(editor.getJSON().content![0]!.content![0]!.marks).toEqual([{ type: 'bold' }])
		} finally {
			editor.destroy()
		}
	})

	it('resolves native labels to titles and accepts document destinations', () => {
		const references = [
			{
				id: 'chapter-first',
				title: '实施方案',
				kind: 'heading' as const,
				location: { documentId: 'one', position: 0 },
			},
			{ id: 'chapter-appendix', title: '固定附录', kind: 'heading' as const },
		]
		const editor = createTypstDocumentEditor({ content: document('参见'), references })
		try {
			editor.commands.setTextSelection(3)
			expect(editor.commands.insertTypstReference(references[0]!.id)).toBe(true)
			expect(editor.getText()).toBe('参见实施方案')
			expect(editor.getText()).not.toContain('chapter-first')
			editor.commands.setTextSelection({ from: 3, to: 4 })
			const plugin = editor.state.plugins.find(
				(candidate) => candidate.props.clipboardTextSerializer,
			)!
			const clipboard = plugin.props.clipboardTextSerializer!.call(
				plugin,
				editor.state.selection.content(),
				editor.view,
			)
			expect(clipboard).toBe('实施方案')
			expect((editor.getJSON() as JSONContent).content![0]!.content![1]!.attrs).toEqual({
				target: 'chapter-first',
				showCaption: null,
			})
			references[0]!.title = '更新后的方案'
			expect(editor.getText()).toBe('参见更新后的方案')
			editor.commands.setTextSelection(4)
			expect(editor.commands.insertTypstReference(references[1]!.id)).toBe(true)
			expect(editor.getText()).toBe('参见更新后的方案固定附录')
		} finally {
			editor.destroy()
		}
	})

	it('edits tables and native formulas and rebinds references when duplicating an object', () => {
		const editor = createTypstDocumentEditor({ content: document('正文') })
		try {
			expect(
				editor.commands.insertTypstFigure({
					body: { type: 'image', attrs: { src: '/body-assets/diagram.svg' } },
					label: 'object-figure',
					caption: [
						{ type: 'text', text: '系统结构' },
						{ type: 'reference', attrs: { target: 'object-figure', showCaption: false } },
					],
				}),
			).toBe(true)
			let position = -1
			editor.state.doc.descendants((node, at) => {
				if (node.type.name === 'figure') position = at
			})
			const figure = editor.state.doc.nodeAt(position)!
			expect(figure.attrs).toEqual({ label: 'object-figure' })
			expect(editor.commands.duplicateTypstFigure(position)).toBe(true)
			const copy = editor.state.doc.nodeAt(position + figure.nodeSize)!
			expect(copy.type.name).toBe('figure')
			expect(copy.attrs.label).toMatch(/^object-/)
			expect(copy.attrs.label).not.toBe(figure.attrs.label)
			expect(copy.child(1).child(1).attrs.target).toBe(copy.attrs.label)
			expect(copy.textContent).toBe('系统结构')
			editor.commands.setTextSelection(editor.state.doc.content.size - 1)
			expect(
				editor.commands.insertContent({
					type: 'blockMath',
					attrs: { expression: 'E = m c^2', label: 'object-equation' },
				}),
			).toBe(true)
			const equations: Record<string, unknown>[] = []
			editor.state.doc.descendants((node) => {
				if (node.type.name === 'blockMath') equations.push(node.attrs)
			})
			expect(equations).toHaveLength(1)
			expect(equations[0]).toEqual({ expression: 'E = m c^2', label: 'object-equation' })
			expect(editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })).toBe(true)
			expect(editor.state.doc.toJSON()).not.toHaveProperty('source')
			expect(editor.schema.nodes).not.toHaveProperty('typstSource')
			expect(editor.schema.nodes).not.toHaveProperty('typstField')
		} finally {
			editor.destroy()
		}
	})

	it('preserves selections for equal host echoes and maps a changed host range without emitting edits', () => {
		const changed = vi.fn()
		const editor = createTypstDocumentEditor({ content: document('原始正文'), onChange: changed })
		try {
			editor.commands.setTextSelection({ from: 2, to: 4 })
			const selection = editor.state.selection
			synchronizeDocument(editor, document('原始正文'))
			expect(editor.state.selection).toBe(selection)
			synchronizeDocument(editor, document('原始正文，远端补充'))
			expect(editor.state.selection.from).toBe(2)
			expect(editor.state.selection.to).toBe(4)
			expect(editor.getText()).toBe('原始正文，远端补充')
			expect(changed).not.toHaveBeenCalled()
		} finally {
			editor.destroy()
		}
	})

	it('routes availability and native commands through the host history owner', () => {
		const history = { canUndo: true, canRedo: false, undo: vi.fn(), redo: vi.fn() }
		const editor = createTypstDocumentEditor({ content: document('正文'), history })
		try {
			expect(editor.can().undo()).toBe(true)
			expect(editor.can().redo()).toBe(false)
			expect(history.undo).not.toHaveBeenCalled()
			expect(editor.commands.undo()).toBe(true)
			expect(history.undo).toHaveBeenCalledOnce()
			history.canUndo = false
			history.canRedo = true
			expect(editor.can().undo()).toBe(false)
			expect(editor.commands.redo()).toBe(true)
			expect(history.redo).toHaveBeenCalledOnce()
			editor.setEditable(false, false)
			expect(editor.commands.redo()).toBe(false)
			expect(history.redo).toHaveBeenCalledOnce()
		} finally {
			editor.destroy()
		}
	})

	it('allows a host history callback to replace content synchronously without a stale native transaction', () => {
		const editor = createTypstDocumentEditor({
			content: document('最新正文'),
			history: {
				canUndo: true,
				canRedo: false,
				undo: () => synchronizeDocument(editor, document('原始正文')),
				redo: () => {},
			},
		})
		try {
			expect(editor.commands.undo()).toBe(true)
			expect(editor.getText()).toBe('原始正文')
		} finally {
			editor.destroy()
		}
	})

	it('rejects source-only attributes and invalid document schemas', () => {
		expect(() =>
			createTypstDocumentEditor({
				content: {
					type: 'doc',
					content: [{ type: 'paragraph', attrs: { source: '#secret[content]' } }],
				},
			}),
		).toThrow('Unsupported paragraph attribute: source')
		expect(() =>
			createTypstDocumentEditor({
				content: {
					type: 'doc',
					content: [{ type: 'typstSource', attrs: { source: '#secret[content]' } }],
				},
			}),
		).toThrow('Unsupported document node: typstSource')
		expect(() =>
			createTypstDocumentEditor({
				content: {
					type: 'doc',
					content: [{ type: 'figure', attrs: { id: 'figure-one', label: 'fig:native' } }],
				},
			}),
		).toThrow('Unsupported figure attribute: id')
	})
})

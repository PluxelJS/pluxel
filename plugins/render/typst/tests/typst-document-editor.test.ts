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

	it('resolves opaque references to titles and accepts document destinations', () => {
		const references = [
			{
				id: 'opaque/chapter/1',
				title: '实施方案',
				kind: 'heading' as const,
				location: { documentId: 'one', position: 0 },
			},
			{ id: 'opaque/fixed/appendix', title: '固定附录', kind: 'heading' as const },
		]
		const editor = createTypstDocumentEditor({ content: document('参见'), references })
		try {
			editor.commands.setTextSelection(3)
			expect(editor.commands.insertTypstReference(references[0]!.id)).toBe(true)
			expect(editor.getText()).toBe('参见实施方案')
			expect(editor.getText()).not.toContain('opaque')
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
				target: 'opaque/chapter/1',
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

	it('uses the existing figure, equation and table commands without native source labels', () => {
		const editor = createTypstDocumentEditor({ content: document('正文') })
		try {
			expect(
				editor.commands.insertTypstFigure({
					body: { type: 'image', attrs: { src: '/document-api/asset/diagram' } },
					caption: [{ type: 'text', text: '系统结构' }],
				}),
			).toBe(true)
			let position = -1
			editor.state.doc.descendants((node, at) => {
				if (node.type.name === 'figure') position = at
			})
			const figure = editor.state.doc.nodeAt(position)!
			expect(Object.keys(figure.attrs)).toEqual(['id'])
			expect(typeof figure.attrs.id).toBe('string')
			expect(editor.commands.duplicateTypstFigure(position)).toBe(true)
			const copy = editor.state.doc.nodeAt(position + figure.nodeSize)!
			expect(copy.type.name).toBe('figure')
			expect(copy.attrs.id).not.toBe(figure.attrs.id)
			expect(copy.textContent).toBe('系统结构')
			editor.commands.setTextSelection(editor.state.doc.content.size - 1)
			expect(editor.commands.insertBlockMath({ latex: 'E=mc^2' })).toBe(true)
			const equations: Record<string, unknown>[] = []
			editor.state.doc.descendants((node) => {
				if (node.type.name === 'blockMath') equations.push(node.attrs)
			})
			expect(equations).toHaveLength(1)
			expect(equations[0]).toMatchObject({ latex: 'E=mc^2' })
			expect(equations[0]).not.toHaveProperty('label')
			expect(editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })).toBe(true)
			expect(editor.state.doc.toJSON()).not.toHaveProperty('source')
			expect(editor.schema.nodes).not.toHaveProperty('typstSource')
			expect(editor.schema.nodes).not.toHaveProperty('typstField')
		} finally {
			editor.destroy()
		}
	})

	it('preserves host-managed fixed content while editing surrounding text', () => {
		const changed = vi.fn()
		const content: JSONContent = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '开始' },
						{ type: 'documentInline', attrs: { key: 'fixed-inline', title: '固定字段' } },
						{ type: 'text', text: '结束' },
					],
				},
				{ type: 'documentBlock', attrs: { key: 'fixed-block', title: '固定内容' } },
				paragraph('正文'),
			],
		}
		const editor = createTypstDocumentEditor({ content, onChange: changed })
		try {
			const initial = editor.state.doc
			editor.view.dispatch(editor.state.tr.delete(3, 4))
			expect(editor.state.doc.eq(initial)).toBe(true)
			editor.view.dispatch(
				editor.state.tr.setNodeAttribute(initial.child(0).nodeSize, 'title', '改写固定内容'),
			)
			expect(editor.state.doc.eq(initial)).toBe(true)
			expect(changed).not.toHaveBeenCalled()
			editor.commands.insertContentAt(1, { type: 'text', text: '新增：' })
			expect(editor.getText()).toContain('新增：开始固定字段结束')
			expect(changed).toHaveBeenCalledOnce()
			const remote = structuredClone(content)
			remote.content![1]!.attrs!.title = '服务端更新后的固定内容'
			synchronizeDocument(editor, remote)
			expect(editor.getText()).toContain('服务端更新后的固定内容')
			expect(changed).toHaveBeenCalledOnce()
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
		).toThrow('Unsupported figure attribute: label')
	})
})

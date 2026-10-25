import { Editor, type JSONContent } from '@tiptap/core'
import { CellSelection } from '@tiptap/pm/tables'
import { describe, expect, it } from 'vitest'
import { createTypstExtensions } from '../src/tiptap/index'
import {
	selectionAlignment,
	selectionBlockType,
	selectionTextStyle,
} from '../src/tiptap/selection-format'

function text(value: string, attrs?: Record<string, string>): JSONContent {
	return { type: 'text', text: value, ...(attrs ? { marks: [{ type: 'textStyle', attrs }] } : {}) }
}
function editor(content: JSONContent[]) {
	return new Editor({
		element: null,
		extensions: createTypstExtensions(),
		content: { type: 'doc', content },
	})
}

describe('native selection format display', () => {
	it('reports mixed heading levels and quote context instead of choosing a misleading block type', () => {
		const e = editor([
			{ type: 'heading', attrs: { level: 1 }, content: [text('A')] },
			{ type: 'heading', attrs: { level: 2 }, content: [text('B')] },
			{ type: 'paragraph', content: [text('C')] },
			{ type: 'blockquote', content: [{ type: 'paragraph', content: [text('D')] }] },
			{ type: 'codeBlock', content: [text('E')] },
		])
		try {
			e.commands.setTextSelection(1)
			expect(selectionBlockType(e)).toBe('heading-1')
			e.commands.setTextSelection({ from: 1, to: 5 })
			expect(selectionBlockType(e)).toBeNull()
			e.commands.setTextSelection({ from: 4, to: 8 })
			expect(selectionBlockType(e)).toBeNull()
			e.commands.setTextSelection(11)
			expect(selectionBlockType(e)).toBe('blockquote')
			e.commands.setTextSelection({ from: 7, to: 12 })
			expect(selectionBlockType(e)).toBeNull()
			e.commands.setTextSelection(15)
			expect(selectionBlockType(e)).toBe('codeBlock')
		} finally {
			e.destroy()
		}
	})

	it('counts unstyled text and canonicalizes equivalent display values without changing JSON', () => {
		const e = editor([
			{
				type: 'paragraph',
				content: [
					text('A', { fontFamily: 'Liberation Serif', fontSize: '18pt', color: '#ff0000' }),
					text('B', {
						fontFamily: '"Liberation Serif"',
						fontSize: '24px',
						color: 'rgb(255, 0, 0)',
					}),
					text('C'),
				],
			},
		])
		try {
			const original = e.getJSON()
			e.commands.setTextSelection({ from: 1, to: 3 })
			expect(selectionTextStyle(e)).toEqual({
				fontFamily: 'Liberation Serif',
				fontSize: '18pt',
				color: 'rgba(255, 0, 0, 1)',
				backgroundColor: '',
			})
			e.commands.setTextSelection({ from: 1, to: 4 })
			expect(selectionTextStyle(e)).toEqual({
				fontFamily: null,
				fontSize: null,
				color: null,
				backgroundColor: '',
			})
			expect(e.getJSON()).toEqual(original)
		} finally {
			e.destroy()
		}
	})

	it('honors an explicitly cleared stored mark set at a styled caret', () => {
		const e = editor([{ type: 'paragraph', content: [text('AB', { fontSize: '18pt' })] }])
		try {
			e.commands.setTextSelection(2)
			expect(selectionTextStyle(e).fontSize).toBe('18pt')
			e.view.dispatch(e.state.tr.setStoredMarks([]))
			expect(selectionTextStyle(e).fontSize).toBe('')
			expect(e.state.selection.$from.marks()).toHaveLength(1)
		} finally {
			e.destroy()
		}
	})

	it('reads disjoint native cell ranges without including unselected cells', () => {
		const e = editor([
			{
				type: 'table',
				content: [0, 1].map(() => ({
					type: 'tableRow',
					content: [
						{
							type: 'tableCell',
							content: [
								{
									type: 'paragraph',
									attrs: { textAlign: 'center' },
									content: [text('A', { fontSize: '18pt' })],
								},
							],
						},
						{
							type: 'tableCell',
							content: [
								{
									type: 'paragraph',
									attrs: { textAlign: 'right' },
									content: [text('B', { fontSize: '12pt' })],
								},
							],
						},
					],
				})),
			},
		])
		try {
			const cells: number[] = []
			e.state.doc.descendants((node, pos) => {
				if (node.type.name === 'tableCell') cells.push(pos)
			})
			e.view.dispatch(
				e.state.tr.setSelection(CellSelection.create(e.state.doc, cells[0]!, cells[2]!)),
			)
			expect(selectionTextStyle(e).fontSize).toBe('18pt')
			expect(selectionAlignment(e)).toBe('center')
			e.view.dispatch(
				e.state.tr.setSelection(CellSelection.create(e.state.doc, cells[0]!, cells[3]!)),
			)
			expect(selectionTextStyle(e).fontSize).toBeNull()
			expect(selectionAlignment(e)).toBeNull()
		} finally {
			e.destroy()
		}
	})

	it('distinguishes inherited alignment from explicit left and handles an empty paragraph', () => {
		const e = editor([
			{ type: 'paragraph', content: [text('A')] },
			{ type: 'paragraph', attrs: { textAlign: 'left' } },
		])
		try {
			e.commands.setTextSelection(1)
			expect(selectionAlignment(e)).toBe('')
			e.commands.setTextSelection({ from: 1, to: 4 })
			expect(selectionAlignment(e)).toBeNull()
		} finally {
			e.destroy()
		}
	})
})

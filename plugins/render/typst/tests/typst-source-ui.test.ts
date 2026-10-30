import { describe, expect, it } from 'vitest'
import { createTypstSourceProject } from '../src/source/node'
import { createTypstSourceEditor, prepareTypstSourceCopy } from '../src/tiptap/source-editor'
import type { EditorUiContext } from '../src/tiptap/editor-ui'
import { prepareInsertion, tableEntry, tableSizeLimits } from '../src/tiptap/insert-commands'
import { captureBlockTarget, prepareBlockAction } from '../src/tiptap/block-actions'
import { prepareLink } from '../src/tiptap/link-actions'

function setup(source: string) {
	const project = createTypstSourceProject({
		files: { 'main.typ': source, 'a.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' },
	})
	const editor = createTypstSourceEditor({ project, path: 'main.typ' })
	const ui: EditorUiContext = {
		composing: false,
		editable: true,
		fontFamilies: [],
		slashCommands: [],
		validateDocument: (document) =>
			project.prepareEdit({ projection: project.open('main.typ'), document }).ok,
		prepareDuplicate: (view, position) =>
			prepareTypstSourceCopy(view, project, 'main.typ', position),
	}
	return { project, editor, ui }
}

describe('source editor UI transaction preparation', () => {
	it('prepares table insertion without changing source and commits one undoable source transaction', () => {
		const { project, editor, ui } = setup('/table')
		try {
			for (const rows of [0, 1.5, tableSizeLimits.rows + 1])
				expect(tableEntry({ rows, cols: 2, withHeaderRow: true })).toBeUndefined()
			editor.commands.setTextSelection(7)
			const transaction = prepareInsertion(
				editor,
				ui,
				tableEntry({ rows: 2, cols: 3, withHeaderRow: true })!,
				{ from: 1, to: 7 },
			)
			expect(transaction).toBeDefined()
			expect(project.snapshot().files['main.typ']).toBe('/table')
			editor.view.dispatch(transaction!)
			expect(project.snapshot().files['main.typ']).toContain('#table(')
			expect(editor.state.doc.firstChild!.type.name).toBe('table')
			expect(editor.state.doc.firstChild!.firstChild!.childCount).toBe(3)
			expect(editor.commands.undo()).toBe(true)
			expect(project.snapshot().files['main.typ']).toBe('/table')
			expect(editor.commands.redo()).toBe(true)
		} finally {
			editor.destroy()
		}
	})

	it('prepares source-preserving block duplication and rejects stale captured targets', () => {
		const original =
			'First.\n\n#figure(image("a.svg", width: 40pt), placement: top, caption: [Original.]) <fig:a>\n\nSee @fig:a.\n'
		const { project, editor, ui } = setup(original)
		try {
			const position = project
				.open('main.typ')
				.mapping.find(
					(entry) =>
						entry.kind === 'node' && entry.nodePath.length === 1 && entry.nodePath[0] === 1,
				)!.position
			const target = captureBlockTarget(editor, position)!
			const transaction = prepareBlockAction(editor, ui, target, 'duplicate')
			expect(transaction).toBeDefined()
			expect(project.snapshot().files['main.typ']).toBe(original)
			editor.view.dispatch(transaction!)
			const source = project.snapshot().files['main.typ'] as string
			expect(source.match(/placement: top/g)).toHaveLength(2)
			expect(new Set(project.open('main.typ').labels.map((label) => label.label)).size).toBe(2)
			expect(prepareBlockAction(editor, ui, target, 'delete')).toBeUndefined()
			editor.commands.undo()
			expect(project.snapshot().files['main.typ']).toBe(original)
		} finally {
			editor.destroy()
		}
	})

	it('writes a selected link to source, validates protocol and preserves surrounding unknown content', () => {
		const original = 'Visit the site. #upper("keep")\n'
		const { project, editor, ui } = setup(original)
		try {
			editor.commands.setTextSelection({ from: 11, to: 15 })
			expect(prepareLink(editor, ui, { href: 'javascript:alert(1)' })).toBeUndefined()
			const transaction = prepareLink(editor, ui, { href: 'https://example.com/' })
			expect(transaction).toBeDefined()
			expect(project.snapshot().files['main.typ']).toBe(original)
			editor.view.dispatch(transaction!)
			expect(project.snapshot().files['main.typ']).toContain('#link("https://example.com/")[site]')
			expect(project.snapshot().files['main.typ']).toContain('#upper("keep")')
			editor.commands.undo()
			expect(project.snapshot().files['main.typ']).toBe(original)
		} finally {
			editor.destroy()
		}
	})
})

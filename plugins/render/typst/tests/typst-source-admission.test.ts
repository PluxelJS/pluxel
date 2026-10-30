import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import { createTypstSourceProject } from '../src/source/node.js'
import type { TypstSourceDiagnostic } from '../src/source/types.js'
import { createTypstSourceEditor, sourceSync } from '../src/tiptap/source-editor.js'

/** Different editor plugins are independent receivers of the source synchronization transaction. */
describe('source editor admission boundaries', () => {
	it('commits a normal edit even when another extension attaches synchronization metadata', () => {
		const project = createTypstSourceProject({ files: { 'main.typ': 'Human' } })
		const editor = createTypstSourceEditor({ project, path: 'main.typ' })
		try {
			editor.view.dispatch(
				editor.state.tr.insertText('Accepted ', 1).setMeta(sourceSync, { local: true }),
			)
			expect(editor.getText()).toBe('Accepted Human')
			expect(project.snapshot().files['main.typ']).toBe('Accepted Human')
			expect(project.revision).toBe(1)
			expect(editor.commands.undo()).toBe(true)
			expect(editor.getText()).toBe('Human')
			expect(project.snapshot().files['main.typ']).toBe('Human')
		} finally {
			editor.destroy()
		}
	})

	it('does not accept an appended document change during external source synchronization', () => {
		const project = createTypstSourceProject({ files: { 'main.typ': 'Human' } })
		const issues: TypstSourceDiagnostic[] = []
		let externalUpdate = false
		const append = Extension.create({
			name: 'independentAppend',
			addProseMirrorPlugins: () => [
				new Plugin({
					key: new PluginKey('independentAppend'),
					appendTransaction(_transactions, _old, state) {
						if (externalUpdate && state.doc.textContent === 'Agent latest')
							return state.tr.insertText('UNREQUESTED', 1)
						return null
					},
				}),
			],
		})
		const editor = createTypstSourceEditor({
			project,
			path: 'main.typ',
			extensions: [append],
			onIssues: (value) => issues.push(...value),
		})
		try {
			externalUpdate = true
			expect(project.replace({ baseRevision: 0, files: { 'main.typ': 'Agent latest' } }).ok).toBe(
				true,
			)
			expect(project.snapshot().files['main.typ']).toBe('Agent latest')
			expect(editor.getText()).toBe('Agent latest')
			expect(issues).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: 'INVALID_EDIT' })]),
			)
		} finally {
			editor.destroy()
		}
	})

	it('cannot overwrite Agent source after another plugin rejects synchronization', () => {
		const project = createTypstSourceProject({ files: { 'main.typ': 'Human' } })
		const issues: TypstSourceDiagnostic[] = []
		const reject = Extension.create({
			name: 'independentPolicy',
			addProseMirrorPlugins: () => [
				new Plugin({
					key: new PluginKey('independentPolicy'),
					filterTransaction: (transaction) => transaction.doc.textContent !== 'Agent latest',
				}),
			],
		})
		const editor = createTypstSourceEditor({
			project,
			path: 'main.typ',
			extensions: [reject],
			onIssues: (value) => issues.push(...value),
		})
		try {
			project.replace({ baseRevision: 0, files: { 'main.typ': 'Agent latest' } })
			expect(editor.getText()).toBe('Human')
			editor.commands.insertContentAt(1, { type: 'text', text: 'Overwrite' })
			expect(project.snapshot().files['main.typ']).toBe('Agent latest')
			expect(editor.getText()).toBe('Human')
			expect(issues).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: 'INVALID_EDIT' })]),
			)
		} finally {
			editor.destroy()
		}
	})

	it('keeps read-only view commands from undoing another source transaction', () => {
		const project = createTypstSourceProject({ files: { 'main.typ': 'Human' } })
		const editor = createTypstSourceEditor({ project, path: 'main.typ', editable: false })
		try {
			project.apply({
				baseRevision: 0,
				patches: [{ path: 'main.typ', from: 0, to: 5, text: 'Agent' }],
			})
			expect(editor.commands.undo()).toBe(false)
			expect(editor.commands.redo()).toBe(false)
			expect(project.snapshot().files['main.typ']).toBe('Agent')
			expect(editor.getText()).toBe('Agent')
		} finally {
			editor.destroy()
		}
	})

	it('keeps a new empty paragraph and its cursor before the next table', () => {
		const project = createTypstSourceProject({
			files: { 'main.typ': 'Hello\n\n#table(columns: 1, [Cell])' },
		})
		const editor = createTypstSourceEditor({ project, path: 'main.typ' })
		try {
			editor.commands.setTextSelection(6)
			expect(editor.commands.splitBlock()).toBe(true)
			expect(editor.state.doc.child(1).type.name).toBe('paragraph')
			expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
			expect(editor.state.selection.$from.parent.textContent).toBe('')
			editor.commands.insertContent({ type: 'text', text: '中文输入验收𠮷' })
			expect(editor.state.doc.child(1).textContent).toBe('中文输入验收𠮷')
			expect(editor.state.doc.child(2).textContent).toBe('Cell')
		} finally {
			editor.destroy()
		}
	})

	it('keeps the selected text through consecutive typography commands', () => {
		const text = '中文输入验收𠮷'
		const project = createTypstSourceProject({ files: { 'main.typ': `#par[${text}]` } })
		const editor = createTypstSourceEditor({ project, path: 'main.typ' })
		try {
			editor.commands.setTextSelection({ from: 1, to: 1 + text.length })
			editor.commands.toggleBold()
			editor.commands.setFontFamily('Noto Serif CJK SC')
			editor.commands.setFontSize('18pt')
			editor.commands.setColor('#dc2626')
			expect(editor.state.selection.to - editor.state.selection.from).toBe(text.length)
			editor.commands.setBackgroundColor('#fef08a')
			expect(editor.getJSON().content![0]!.content![0]!.marks).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: 'textStyle',
						attrs: expect.objectContaining({
							color: 'rgba(220, 38, 38, 1)',
							backgroundColor: 'rgba(254, 240, 138, 1)',
						}),
					}),
				]),
			)
		} finally {
			editor.destroy()
		}
	})

	it('reports external deletion and safely resumes after the source file is restored', () => {
		const project = createTypstSourceProject({ files: { 'main.typ': 'Human' } })
		const issues: TypstSourceDiagnostic[] = []
		const editor = createTypstSourceEditor({
			project,
			path: 'main.typ',
			onIssues: (value) => issues.push(...value),
		})
		try {
			expect(project.replace({ baseRevision: 0, files: {} }).ok).toBe(true)
			expect(issues).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: 'NOT_FOUND' })]),
			)
			editor.commands.insertContentAt(1, { type: 'text', text: 'Stale' })
			expect(project.snapshot().files).toEqual({})
			expect(project.replace({ baseRevision: 1, files: { 'main.typ': 'Restored' } }).ok).toBe(true)
			expect(editor.getText()).toBe('Restored')
			editor.commands.insertContentAt(1, { type: 'text', text: 'New ' })
			expect(project.snapshot().files['main.typ']).toBe('New Restored')
		} finally {
			editor.destroy()
		}
	})
})

import { describe, expect, it, vi } from 'vitest'
import { Editor, Extension, type Extensions } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { createTypstSourceProject } from '../src/source/node'
import { createTypstSourceEditor } from '../src/tiptap/source-editor'
import { sourceAdmission, sourceSync } from '../src/tiptap/editor-transactions'
import { createTypstExtensions } from '../src/tiptap/extensions'
import type { EditorUiContext } from '../src/tiptap/editor-ui'
import {
	canInsertEntry,
	dispatchInsertion,
	prepareInsertion,
	type InsertEntry,
	type TypstSlashCommand,
} from '../src/tiptap/insert-commands'

function setup(source = '/import', extensions: Extensions = []) {
	const project = createTypstSourceProject({
		files: { 'main.typ': source, 'module.typ': '#let value = 1\n' },
	})
	const editor = createTypstSourceEditor({ project, path: 'main.typ', extensions })
	const ui: EditorUiContext = {
		composing: false,
		editable: true,
		fontFamilies: [],
		slashCommands: [],
		renderSourceFileInput: vi.fn(() => null),
		validateDocument: (document) =>
			project.prepareEdit({ projection: project.open('main.typ'), document }).ok,
	}
	return { project, editor, ui }
}

function inputEntry(input: 'import' | 'include'): InsertEntry {
	return { id: input, title: input, input, group: '文件引用', icon: 'link' }
}

const imported: TypstSlashCommand = {
	id: 'chosen-module',
	title: '导入选定模块',
	command: (chain) =>
		chain.insertContentAt(0, {
			type: 'typstImport',
			attrs: {
				module: 'module.typ',
				alias: 'extras',
				items: null,
				source: '#import "module.typ" as extras',
			},
		}),
}

const included: TypstSlashCommand = {
	id: 'chosen-section',
	title: '插入选定章节',
	command: (chain) =>
		chain.insertContent({
			type: 'typstInclude',
			attrs: { module: 'module.typ', source: '#include "module.typ"' },
		}),
}

describe('deferred source file insertion', () => {
	it('offers input actions without invoking their renderer, validating a guessed document or changing source', () => {
		const { project, editor, ui } = setup()
		try {
			const validate = vi.fn(() => false)
			ui.validateDocument = validate
			for (const kind of ['import', 'include'] as const) {
				const entry = inputEntry(kind)
				for (let attempt = 0; attempt < 3; attempt++)
					expect(canInsertEntry(editor, ui, entry, { from: 1, to: 8 })).toBe(true)
				expect(prepareInsertion(editor, ui, entry, { from: 1, to: 8 })).toBeUndefined()
			}
			expect(ui.renderSourceFileInput).not.toHaveBeenCalled()
			expect(validate).not.toHaveBeenCalled()
			expect(project.snapshot().files['main.typ']).toBe('/import')
			expect(project.revision).toBe(0)
			// The actual submitted command still crosses ordinary source admission.
			expect(prepareInsertion(editor, ui, imported, { from: 1, to: 8 })).toBeUndefined()
			expect(validate).toHaveBeenCalledOnce()
			expect(project.snapshot().files['main.typ']).toBe('/import')
		} finally {
			editor.destroy()
		}
	})

	it('requires a renderer, editable state and a valid current insertion target', () => {
		const { editor, ui } = setup()
		try {
			const entry = inputEntry('include')
			expect(canInsertEntry(editor, { ...ui, renderSourceFileInput: undefined }, entry)).toBe(false)
			expect(canInsertEntry(editor, { ...ui, editable: false }, entry)).toBe(false)
			expect(canInsertEntry(editor, { ...ui, composing: true }, entry)).toBe(false)
			for (const range of [
				{ from: -1, to: 1 },
				{ from: 1, to: 1 },
				{ from: 1, to: 100 },
			])
				expect(canInsertEntry(editor, ui, entry, range)).toBe(false)
			const local = { at: 0, doc: editor.state.doc }
			expect(canInsertEntry(editor, ui, entry, local)).toBe(true)
			expect(canInsertEntry(editor, ui, entry, { ...local, at: 1 })).toBe(false)
			editor.commands.insertContent({ type: 'text', text: 'changed' })
			expect(canInsertEntry(editor, ui, entry, local)).toBe(false)
			editor.setEditable(false)
			expect(canInsertEntry(editor, ui, entry)).toBe(false)
		} finally {
			editor.destroy()
		}
	})

	it('prepares the chosen command only on submission, removing slash text in one undoable transaction', () => {
		const { project, editor, ui } = setup()
		try {
			editor.commands.setTextSelection(8)
			const before = editor.state.doc
			const transaction = prepareInsertion(editor, ui, imported, { from: 1, to: 8 })
			expect(transaction).toBeDefined()
			expect(editor.state.doc).toBe(before)
			expect(project.snapshot().files['main.typ']).toBe('/import')
			editor.view.dispatch(transaction!)
			expect(editor.state.doc.firstChild!.type.name).toBe('typstImport')
			expect(project.snapshot().files['main.typ']).toContain('#import "module.typ" as extras')
			expect(project.snapshot().files['main.typ']).not.toContain('/import')
			expect(project.snapshot().files['module.typ']).toBe('#let value = 1\n')
			expect(editor.commands.undo()).toBe(true)
			expect(project.snapshot().files['main.typ']).toBe('/import')
		} finally {
			editor.destroy()
		}
	})

	it('confirms accepted normalized source without deleting the whitespace before a slash command', () => {
		const original = 'Before. /include\n\nAfter.'
		const { project, editor, ui } = setup(original)
		try {
			editor.commands.setTextSelection(17)
			const transaction = prepareInsertion(editor, ui, included, { from: 9, to: 17 })!
			expect(transaction.doc.firstChild!.textContent).toBe('Before. ')
			expect(dispatchInsertion(editor, transaction)).toBe(true)
			expect(project.snapshot().files['main.typ']).toBe(
				'Before. \n\n#include "module.typ"\n\nAfter.',
			)
			expect(editor.state.doc.firstChild!.textContent).toBe('Before.')
			expect(editor.state.doc.eq(transaction.doc)).toBe(false)
			expect(transaction.getMeta(sourceAdmission).accepted).toBe(true)
			expect(editor.commands.undo()).toBe(true)
			expect(project.snapshot().files['main.typ']).toBe(original)
		} finally {
			editor.destroy()
		}
	})

	it('does not report filtered or rolled back insertions as accepted', () => {
		const policy = Extension.create({
			name: 'rejectImports',
			addProseMirrorPlugins: () => [
				new Plugin({
					filterTransaction: (transaction) =>
						transaction.doc.firstChild?.type.name !== 'typstImport',
				}),
			],
		})
		for (const failure of ['filter', 'commit'] as const) {
			const { project, editor, ui } = setup('/import', failure === 'filter' ? [policy] : [])
			try {
				editor.commands.setTextSelection(8)
				const before = editor.state.doc
				const transaction = prepareInsertion(editor, ui, imported, { from: 1, to: 8 })!
				const reject =
					failure === 'commit'
						? vi.spyOn(project, 'edit').mockReturnValueOnce({ ok: false, issues: [] })
						: undefined
				expect(dispatchInsertion(editor, transaction)).toBe(false)
				expect(editor.state.doc.eq(before)).toBe(true)
				expect(project.snapshot().files['main.typ']).toBe('/import')
				expect(project.revision).toBe(0)
				reject?.mockRestore()
			} finally {
				editor.destroy()
			}
		}
	})

	it('requires the accepted source to synchronize into the view before confirming insertion', () => {
		const policy = Extension.create({
			name: 'rejectSourceRefresh',
			addProseMirrorPlugins: () => [
				new Plugin({ filterTransaction: (transaction) => !transaction.getMeta(sourceSync) }),
			],
		})
		const { project, editor, ui } = setup('Before. /include\n\nAfter.', [policy])
		try {
			editor.commands.setTextSelection(17)
			const transaction = prepareInsertion(editor, ui, included, { from: 9, to: 17 })!
			expect(dispatchInsertion(editor, transaction)).toBe(false)
			expect(project.snapshot().files['main.typ']).toContain('#include "module.typ"')
			expect(editor.state.doc.eq(transaction.doc)).toBe(true)
			expect(transaction.getMeta(sourceAdmission).accepted).toBe(false)
		} finally {
			editor.destroy()
		}
	})

	it('keeps exact document confirmation for ordinary editors without a source admission receipt', () => {
		const editor = new Editor({
			element: null,
			extensions: createTypstExtensions(),
			content: {
				type: 'doc',
				content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }],
			},
		})
		try {
			editor.view.updateState(
				editor.state.reconfigure({ plugins: editor.extensionManager.plugins }),
			)
			const first = editor.state.tr.insertText('B', 1)
			expect(dispatchInsertion(editor, first)).toBe(true)
			expect(first.getMeta(sourceAdmission)).toBeUndefined()
			editor.registerPlugin(
				new Plugin({
					appendTransaction(transactions, _old, state) {
						return transactions.some((transaction) => transaction.getMeta('additionalEdit'))
							? null
							: state.tr.insertText('Unexpected ', 1).setMeta('additionalEdit', true)
					},
				}),
			)
			expect(dispatchInsertion(editor, editor.state.tr.insertText('C', 1))).toBe(false)
		} finally {
			editor.destroy()
		}
	})
})

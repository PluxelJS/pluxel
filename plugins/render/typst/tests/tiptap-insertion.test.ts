import { Editor } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'
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
	insertEntries,
	matchesInsertion,
	prepareInsertion,
	tableEntry,
	tableSizeLimits,
	type TypstSlashCommand,
} from '../src/tiptap/insert-commands'

const defaults = { title: 'Default', nested: { amount: 1 } }
const config: TypstEditorConfig = {
	regions: [{ id: 'body' }],
	fields: [
		{ path: ['customer'], label: '客户名称' },
		{ path: ['amount'], label: '金额' },
	],
	extensions: [
		TypstSource,
		TypstTemplateBlock.configure({
			templates: [{ id: 'summary', label: '摘要组件', source: '#props.title', defaults }],
		}),
	],
}

function context(rules = config, commands: readonly TypstSlashCommand[] = []): EditorUiContext {
	return {
		config: rules,
		region: rules.regions[0],
		editable: true,
		composing: false,
		fontFamilies: [],
		slashCommands: commands,
	}
}

function createEditor(text: string, rules = config) {
	const editor = new Editor({
		element: null,
		extensions: createTypstExtensions(rules),
		content: {
			type: 'doc',
			content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
		},
	})
	const admission = vi.fn(() => true)
	editor.view.updateState(
		editor.state.reconfigure({
			plugins: [history(), new Plugin({ filterTransaction: admission })],
		}),
	)
	editor.view.dispatch(
		editor.state.tr.setSelection(TextSelection.create(editor.state.doc, text.length + 1)),
	)
	admission.mockClear()
	return { editor, admission }
}

describe('shared insertion commands', () => {
	it('validates interactive table dimensions and inserts a custom table with slash removal in one history event', () => {
		const { editor, admission } = createEditor('/table')
		try {
			const before = editor.getJSON()
			for (const size of [
				{ rows: 0, cols: 3 },
				{ rows: 2.5, cols: 3 },
				{ rows: tableSizeLimits.rows + 1, cols: 3 },
				{ rows: 2, cols: NaN },
				{ rows: 2, cols: tableSizeLimits.cols + 1 },
			])
				expect(tableEntry({ ...size, withHeaderRow: true })).toBeUndefined()
			const entry = tableEntry({ rows: 2, cols: 4, withHeaderRow: false })!
			const transaction = prepareInsertion(editor, context(), entry, { from: 1, to: 7 })!
			expect(admission).not.toHaveBeenCalled()
			expect(editor.getJSON()).toEqual(before)
			editor.view.dispatch(transaction)
			const table = editor.state.doc.firstChild!
			expect(table.type.name).toBe('table')
			expect(table.childCount).toBe(2)
			for (let row = 0; row < table.childCount; row++) {
				expect(table.child(row).childCount).toBe(4)
				expect(table.child(row).firstChild!.type.name).toBe('tableCell')
			}
			expect(admission).toHaveBeenCalledTimes(1)
			expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(before)
			expect(undo(editor.state)).toBe(false)
		} finally {
			editor.destroy()
		}
	})

	it('keeps table header and editing permission under the same region admission', () => {
		const rules = {
			...config,
			regions: [{ id: 'body', nodes: ['paragraph', 'text', 'table', 'tableRow', 'tableCell'] }],
		}
		const { editor, admission } = createEditor('/table', rules)
		try {
			const ui = context(rules)
			const range = { from: 1, to: 7 }
			const plain = tableEntry({ rows: 2, cols: 2, withHeaderRow: false })!
			expect(prepareInsertion(editor, ui, plain, range)).toBeDefined()
			expect(
				prepareInsertion(editor, ui, tableEntry({ rows: 2, cols: 2, withHeaderRow: true })!, range),
			).toBeUndefined()
			for (const policy of [
				{ ...ui, editable: false },
				{ ...ui, composing: true },
			])
				expect(prepareInsertion(editor, policy, plain, range)).toBeUndefined()
			expect(admission).not.toHaveBeenCalled()
			expect(editor.state.doc.textContent).toBe('/table')
		} finally {
			editor.destroy()
		}
	})
	it('derives the same searchable actions from region rules, fields and installed extensions', () => {
		const custom: TypstSlashCommand = {
			id: 'notice',
			title: '提示块',
			keywords: ['notice'],
			command: (chain) => chain.setBlockquote(),
		}
		const { editor } = createEditor('Keep')
		try {
			const entries = insertEntries(editor, context(config, [custom]))
			expect([...new Set(entries.map((entry) => entry.group))]).toEqual([
				'内容',
				'数据字段',
				'模板组件',
				'段落',
			])
			expect(entries.map((entry) => entry.id)).toEqual(
				expect.arrayContaining([
					'paragraph',
					'heading-2',
					'bulletList',
					'table',
					'typstSource',
					'custom:notice',
					'field:["customer"]',
					'template:summary',
				]),
			)
			expect(entries.filter((entry) => matchesInsertion(entry, 'HEADING'))).toHaveLength(6)
			expect(
				entries.filter((entry) => matchesInsertion(entry, '客户')).map((entry) => entry.id),
			).toEqual(['field:["customer"]'])
			expect(
				entries.filter((entry) => matchesInsertion(entry, 'summary')).map((entry) => entry.id),
			).toEqual(['template:summary'])
			const restricted = {
				...config,
				regions: [
					{ id: 'body', nodes: ['paragraph', 'text', 'dataField'], fields: [['customer']] },
				],
			}
			expect(insertEntries(editor, context(restricted)).map((entry) => entry.id)).toEqual([
				'field:["customer"]',
				'paragraph',
			])
		} finally {
			editor.destroy()
		}
	})

	it('prepares without dispatch, then removes a slash query and inserts a component with one undo', () => {
		const { editor, admission } = createEditor('/summary')
		try {
			const ui = context()
			const entry = insertEntries(editor, ui).find((item) => item.id === 'template:summary')!
			const before = editor.getJSON()
			const state = editor.state
			const range = { from: 1, to: 9 }
			for (let attempt = 0; attempt < 3; attempt++)
				expect(prepareInsertion(editor, ui, entry, range)).toBeDefined()
			expect(editor.state).toBe(state)
			expect(editor.getJSON()).toEqual(before)
			expect(admission).not.toHaveBeenCalled()
			expect(undo(editor.state)).toBe(false)
			const transaction = prepareInsertion(editor, ui, entry, range)!
			editor.view.dispatch(transaction)
			expect(admission).toHaveBeenCalledTimes(1)
			const inserted = editor.getJSON()
			expect(editor.state.doc.textContent).not.toContain('/summary')
			const node = inserted.content!.find((item) => item.type === 'templateBlock')!
			expect(node.attrs).toMatchObject({ template: 'summary', props: defaults, dataPath: [] })
			expect(node.attrs!.props).not.toBe(defaults)
			expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(before)
			expect(undo(editor.state)).toBe(false)
			expect(redo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(inserted)
			expect(defaults).toEqual({ title: 'Default', nested: { amount: 1 } })
		} finally {
			editor.destroy()
		}
	})

	it('inserts an explicitly enabled empty source block at the caret without deleting adjacent text', () => {
		const { editor } = createEditor('Keep this text')
		try {
			const ui = context()
			const entry = insertEntries(editor, ui).find((item) => item.id === 'typstSource')!
			const before = editor.getJSON()
			editor.view.dispatch(prepareInsertion(editor, ui, entry)!)
			expect(editor.state.doc.textContent).toBe('Keep this text')
			const source = editor.getJSON().content!.find((node) => node.type === 'typstSource')!
			expect(source.attrs).toMatchObject({ source: '', id: expect.any(String) })
			expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(before)
		} finally {
			editor.destroy()
		}
		const plain: TypstEditorConfig = { regions: [{ id: 'body' }], fields: [] }
		const { editor: plainEditor } = createEditor('No opt-in', plain)
		try {
			expect(
				insertEntries(plainEditor, context(plain)).some((entry) => entry.id === 'typstSource'),
			).toBe(false)
			expect(
				insertEntries(plainEditor, context(plain)).some((entry) =>
					entry.id.startsWith('template:'),
				),
			).toBe(false)
		} finally {
			plainEditor.destroy()
		}
	})

	it('rejects failed or forbidden compositions without consuming slash input or running admission', () => {
		const rules = { ...config, regions: [{ id: 'body', nodes: ['paragraph', 'text'] }] }
		const { editor, admission } = createEditor('/heading', rules)
		try {
			const ui = context(rules)
			const before = editor.getJSON()
			const forbidden: TypstSlashCommand = {
				id: 'heading',
				title: 'Forbidden heading',
				command: (chain) => chain.setHeading({ level: 2 }),
			}
			const failed: TypstSlashCommand = {
				id: 'failure',
				title: 'Failed native command',
				command: (chain) => chain.command(() => false).setParagraph(),
			}
			for (const entry of [forbidden, failed])
				for (const range of [undefined, { from: 1, to: 9 }])
					expect(prepareInsertion(editor, ui, entry, range)).toBeUndefined()
			expect(editor.getJSON()).toEqual(before)
			expect(admission).not.toHaveBeenCalled()
			expect(undo(editor.state)).toBe(false)
		} finally {
			editor.destroy()
		}
	})

	it('rechecks editing permission, composition and bounds before composing a command', () => {
		const { editor, admission } = createEditor('/source')
		try {
			const ui = context()
			const command = vi.fn((chain) => chain.insertTypstSource(''))
			const entry: TypstSlashCommand = { id: 'source', title: 'Source', command }
			const before = editor.getJSON()
			for (const policy of [
				{ ...ui, editable: false },
				{ ...ui, composing: true },
			])
				expect(prepareInsertion(editor, policy, entry, { from: 1, to: 8 })).toBeUndefined()
			for (const range of [
				{ from: -1, to: 8 },
				{ from: 1, to: 99 },
				{ from: 4, to: 2 },
				{ from: 1.5, to: 8 },
			])
				expect(prepareInsertion(editor, ui, entry, range)).toBeUndefined()
			editor.setEditable(false)
			admission.mockClear()
			expect(prepareInsertion(editor, ui, entry)).toBeUndefined()
			expect(command).not.toHaveBeenCalled()
			expect(admission).not.toHaveBeenCalled()
			expect(editor.getJSON()).toEqual(before)
		} finally {
			editor.destroy()
		}
	})
})

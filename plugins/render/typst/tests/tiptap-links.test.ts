import { Editor, type JSONContent } from '@tiptap/core'
import { history, redo, undo } from '@tiptap/pm/history'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import { describe, expect, it, vi } from 'vitest'
import {
	createTypstExtensions,
	generateTypstRegions,
	validateTypstRegions,
	type TypstEditorConfig,
} from '../src/tiptap/index'
import type { EditorUiContext } from '../src/tiptap/editor-ui'
import { prepareLink, safeLink } from '../src/tiptap/link-actions'

const config: TypstEditorConfig = { regions: [{ id: 'body' }], fields: [] }
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
function createEditor(content: JSONContent[] = [{ type: 'text', text: 'Before linked after' }]) {
	const editor = new Editor({
		element: null,
		extensions: createTypstExtensions(config),
		content: { type: 'doc', content: [{ type: 'paragraph', content }] },
	})
	const admission = vi.fn(() => true)
	editor.view.updateState(
		editor.state.reconfigure({
			plugins: [history(), new Plugin({ filterTransaction: admission })],
		}),
	)
	return { editor, admission }
}
function select(editor: Editor, from: number, to = from) {
	editor.view.dispatch(
		editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
	)
}
function hrefs(editor: Editor) {
	const result: { text: string; href?: string }[] = []
	editor.state.doc.descendants((node) => {
		if (node.isText)
			result.push({
				text: node.text!,
				href: node.marks.find((mark) => mark.type.name === 'link')?.attrs.href,
			})
	})
	return result
}

describe('native link actions', () => {
	it('prepares without dispatch and links only the selected text with one undo/redo', () => {
		const { editor, admission } = createEditor()
		try {
			select(editor, 8, 14)
			admission.mockClear()
			const before = editor.getJSON()
			const selection = editor.state.selection
			for (let attempt = 0; attempt < 3; attempt++)
				expect(prepareLink(editor, context(), { href: 'https://example.com' })).toBeDefined()
			expect(editor.getJSON()).toEqual(before)
			expect(editor.state.selection).toBe(selection)
			expect(admission).not.toHaveBeenCalled()
			editor.view.dispatch(prepareLink(editor, context(), { href: 'https://example.com' })!)
			expect(admission).toHaveBeenCalledTimes(1)
			expect(hrefs(editor)).toEqual([
				{ text: 'Before ' },
				{ text: 'linked', href: 'https://example.com' },
				{ text: ' after' },
			])
			const generated = generateTypstRegions({
				regions: { body: editor.getJSON() },
				config,
				data: {},
				snapshotRevision: 1,
			})
			expect(generated.ok).toBe(true)
			if (!generated.ok) throw new Error('Link serialization failed')
			expect(Object.values(generated.value.templateFiles).join('\n')).toContain(
				'#link("https://example.com")[#text("linked")]',
			)
			const after = editor.getJSON()
			expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(before)
			expect(undo(editor.state)).toBe(false)
			expect(redo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(after)
		} finally {
			editor.destroy()
		}
	})

	it('edits the full existing link from a caret and removes it without changing text', () => {
		const { editor } = createEditor([
			{ type: 'text', text: 'Before ' },
			{
				type: 'text',
				text: 'linked',
				marks: [{ type: 'link', attrs: { href: 'https://old.example' } }],
			},
			{ type: 'text', text: ' after' },
		])
		try {
			const before = editor.getJSON()
			select(editor, 10)
			editor.view.dispatch(prepareLink(editor, context(), { href: 'https://new.example' })!)
			expect(hrefs(editor)).toEqual([
				{ text: 'Before ' },
				{ text: 'linked', href: 'https://new.example' },
				{ text: ' after' },
			])
			select(editor, 10)
			editor.view.dispatch(prepareLink(editor, context(), { remove: true })!)
			expect(hrefs(editor)).toEqual([{ text: 'Before linked after' }])
			expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(hrefs(editor)[1].href).toBe('https://new.example')
			expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(before)
		} finally {
			editor.destroy()
		}
	})

	it.each([
		['', 'https://example.com'],
		['Read more', 'Read more'],
	])('inserts a visible link at an empty caret (label %j) in one transaction', (text, expected) => {
		const { editor } = createEditor([{ type: 'text', text: 'Keep ' }])
		try {
			select(editor, 6)
			const before = editor.getJSON()
			editor.view.dispatch(prepareLink(editor, context(), { href: 'https://example.com', text })!)
			expect(hrefs(editor)).toEqual([
				{ text: 'Keep ' },
				{ text: expected, href: 'https://example.com' },
			])
			expect(
				(editor.state.storedMarks ?? editor.state.selection.$from.marks()).some(
					(mark) => mark.type.name === 'link',
				),
			).toBe(false)
			expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(before)
			expect(undo(editor.state)).toBe(false)
		} finally {
			editor.destroy()
		}
	})

	it('refuses empty/unsafe URLs, forbidden marks, host policies, readonly and composition without mutating native state', () => {
		const { editor, admission } = createEditor()
		try {
			select(editor, 8, 14)
			admission.mockClear()
			const before = editor.state
			for (const href of [
				'',
				' javascript:alert(1)',
				'javascript:alert(1)',
				'data:text/html,x',
				'https://example.com\n',
				'https://example.com/a b',
				'https://',
				'https://example.com:invalid',
			]) {
				expect(safeLink(editor, context(), href)).toBe(false)
				expect(prepareLink(editor, context(), { href })).toBeUndefined()
			}
			const allowingEverything = context({ ...config, allowLink: () => true })
			expect(safeLink(editor, allowingEverything, 'javascript:alert(1)')).toBe(false)
			const contexts = [
				context({ ...config, regions: [{ id: 'body', marks: ['bold'] }] }),
				context({ ...config, allowLink: (href) => href.startsWith('https://trusted.example/') }),
				{ ...context(), editable: false },
				{ ...context(), composing: true },
			]
			for (const ui of contexts)
				expect(prepareLink(editor, ui, { href: 'https://example.com' })).toBeUndefined()
			expect(editor.state).toBe(before)
			expect(admission).not.toHaveBeenCalled()
			expect(undo(editor.state)).toBe(false)
		} finally {
			editor.destroy()
		}
	})

	it('uses the same default URL validity for raw JSON and editing without normalizing authored URLs', () => {
		const regions = (href: string) => ({
			body: {
				type: 'doc',
				content: [
					{
						type: 'paragraph',
						content: [{ type: 'text', text: 'Link', marks: [{ type: 'link', attrs: { href } }] }],
					},
				],
			},
		})
		for (const href of ['https://', 'https://example.com:invalid', 'http://[broken'])
			expect(validateTypstRegions({ regions: regions(href), config }).ok).toBe(false)
		for (const href of ['https://EXAMPLE.com/a?b=%2f', 'mailto:?subject=Hello', 'tel:+123', '#'])
			expect(validateTypstRegions({ regions: regions(href), config }).ok).toBe(true)
		const authored = regions('https://EXAMPLE.com/a?b=%2f')
		const before = JSON.stringify(authored)
		expect(validateTypstRegions({ regions: authored, config }).ok).toBe(true)
		expect(JSON.stringify(authored)).toBe(before)
		expect(
			validateTypstRegions({
				regions: regions('custom:destination'),
				config: { ...config, allowLink: (href) => href === 'custom:destination' },
			}).ok,
		).toBe(true)
	})

	it('rechecks the whole region before commit, including unrelated invalid native content', () => {
		const { editor, admission } = createEditor()
		try {
			select(editor, 8, 14)
			editor.commands.setBold()
			admission.mockClear()
			const before = editor.state
			const ui = context({ ...config, regions: [{ id: 'body', marks: ['link'] }] })
			expect(prepareLink(editor, ui, { href: 'https://example.com' })).toBeUndefined()
			expect(editor.state).toBe(before)
			expect(admission).not.toHaveBeenCalled()
		} finally {
			editor.destroy()
		}
	})
})

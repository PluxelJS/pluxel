import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { createTypstSourceProject } from '../src/source/node.js'
import { typstSourceLibrary } from '../src/source/library.js'
import { createTypstSourceEditor } from '../src/tiptap/source-editor.js'

function fixture(source: string) {
	return createTypstSourceProject({
		files: { 'body.typ': source, 'lib/pluxel.typ': typstSourceLibrary },
	})
}
function change(source: string, attrs: Record<string, unknown>) {
	const project = fixture(source),
		projection = project.open('body.typ')
	const document = structuredClone(projection.document)
	const node = document.content!.find((value) => value.type === 'typstImport')!
	Object.assign(node.attrs!, attrs)
	return { project, result: project.edit({ projection, document }) }
}

describe('native static import declarations', () => {
	it('projects namespace, named, renamed and wildcard imports without rewriting source', () => {
		const source =
			'// 保留\r\n#import "lib/pluxel.typ" /* 模块注释 */ as report\r\n#import "blocks.typ": metrics, chart.plot as plot\r\n#import "unknown.typ": *\r\n#import path\r\n正文。\r\n'
		const project = fixture(source),
			projection = project.open('body.typ')
		const nodes = projection.document.content!.filter((node) => node.type === 'typstImport')
		expect(nodes.map((node) => node.attrs)).toEqual([
			{
				module: 'lib/pluxel.typ',
				alias: 'report',
				items: null,
				source: '#import "lib/pluxel.typ" /* 模块注释 */ as report',
			},
			{
				module: 'blocks.typ',
				alias: null,
				items: 'metrics, chart.plot as plot',
				source: '#import "blocks.typ": metrics, chart.plot as plot',
			},
			{ module: 'unknown.typ', alias: null, items: '*', source: '#import "unknown.typ": *' },
		])
		expect(
			projection.document.content!.find((node) => node.type === 'typstSource')?.attrs?.source,
		).toBe('#import path')
		expect(project.edit({ projection, document: structuredClone(projection.document) }).ok).toBe(
			true,
		)
		expect(project.snapshot().files['body.typ']).toBe(source)
	})

	it('changes literal module paths and aliases without discarding import comments or CRLF', () => {
		const source = '#import /* 前 */ "a.typ" /* 中 */ as /* 后 */ old\r\n正文。\r\n'
		const { project, result } = change(source, { module: '新的.typ', alias: 'renamed' })
		expect(result.ok).toBe(true)
		expect(project.snapshot().files['body.typ']).toBe(
			source.replace('a.typ', '新的.typ').replace('old', 'renamed'),
		)
		expect(project.undo().ok).toBe(true)
		expect(project.snapshot().files['body.typ']).toBe(source)
	})

	it('edits named items and binding forms while preserving comments outside their own ranges', () => {
		for (const [source, attrs, expected] of [
			[
				'#import "a.typ": old, chart as c\n正文。',
				{ items: 'new, chart as graph' },
				'#import "a.typ": new, chart as graph\n正文。',
			],
			[
				'#import "a.typ" /* keep */ as old\n正文。',
				{ alias: null, items: '*' },
				'#import "a.typ" /* keep */ : *\n正文。',
			],
			[
				'#import "a.typ": *\n正文。',
				{ alias: 'mod', items: null },
				'#import "a.typ" as mod\n正文。',
			],
			['#import "a.typ"\n正文。', { alias: 'mod' }, '#import "a.typ" as mod\n正文。'],
			['#import "a.typ" as old\n正文。', { alias: null }, '#import "a.typ" \n正文。'],
		] as const) {
			const { project, result } = change(source, attrs)
			expect(result.ok).toBe(true)
			expect(project.snapshot().files['body.typ']).toBe(expected)
		}
	})

	it('accepts equivalent whitespace in imported items through the native parser', () => {
		const { project, result } = change('#import "a.typ": old\n正文。', {
			items: 'new,chart  as graph',
		})
		expect(result.ok).toBe(true)
		expect(project.open('body.typ').document.content![0]!.attrs?.items).toBe('new, chart as graph')
	})

	it('rejects edits that would discard comments inside an import list or binding', () => {
		for (const [source, attrs] of [
			['#import "a.typ": one, /* keep */ two\n正文。', { items: 'one, three' }],
			['#import "a.typ" as /* keep */ mod\n正文。', { alias: null }],
		] as const) {
			const { project, result } = change(source, attrs)
			expect(result.ok).toBe(false)
			expect(project.snapshot().files['body.typ']).toBe(source)
		}
	})

	it('rejects invalid syntax, source mutation and additional-statement injection atomically', () => {
		const source = '#import "a.typ" as mod\n正文。'
		for (const attrs of [
			{ alias: 'bad alias' },
			{ alias: 'new\n= Injected heading' },
			{ alias: null, items: 'name\n#let injected = 1' },
			{ alias: 'mod', items: '*' },
			{ source: '#import "wrong.typ" as mod' },
			{ module: '' },
		]) {
			const { project, result } = change(source, attrs)
			expect(result.ok).toBe(false)
			expect(project.snapshot().files['body.typ']).toBe(source)
		}
	})

	it('keeps existing imports fixed in scope and checks declared field bindings after changes', () => {
		const source =
			'#import "lib/pluxel.typ" as report\n#report.field(json("data.json"), ("company",))\n\n正文。'
		const files = { ...fixture(source).snapshot().files, 'data.json': '{"company":"公司"}' }
		const project = createTypstSourceProject({ files })
		const projection = project.open('body.typ')
		for (const changeDocument of [
			(doc: JSONContent) => doc.content!.splice(0, 1),
			(doc: JSONContent) => doc.content!.push(doc.content!.shift()!),
			(doc: JSONContent) => {
				doc.content![0]!.attrs!.alias = 'different'
			},
		]) {
			const document = structuredClone(projection.document)
			changeDocument(document)
			expect(project.edit({ projection, document }).ok).toBe(false)
			expect(project.snapshot().files).toEqual(files)
		}
	})

	it('supports native editor parameter edits, insertion, undo and redo', () => {
		const project = fixture('#import "a.typ" as mod\n\n正文。')
		const editor = createTypstSourceEditor({ project, path: 'body.typ' })
		try {
			expect(editor.state.doc.firstChild?.type.name).toBe('typstImport')
			editor.commands.setNodeSelection(0)
			expect(editor.commands.updateAttributes('typstImport', { module: 'b.typ' })).toBe(true)
			expect(project.snapshot().files['body.typ']).toBe('#import "b.typ" as mod\n\n正文。')
			expect(editor.commands.undo()).toBe(true)
			expect(project.snapshot().files['body.typ']).toBe('#import "a.typ" as mod\n\n正文。')
			expect(editor.commands.redo()).toBe(true)
			expect(
				editor.commands.insertContentAt(0, {
					type: 'typstImport',
					attrs: { module: 'other.typ', items: 'thing as value' },
				}),
			).toBe(true)
			expect(project.snapshot().files['body.typ']).toBe(
				'#import "other.typ": thing as value\n\n#import "b.typ" as mod\n\n正文。',
			)
		} finally {
			editor.destroy()
		}
	})
})

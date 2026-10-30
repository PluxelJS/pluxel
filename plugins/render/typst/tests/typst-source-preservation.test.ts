import type { JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { createTypstSourceProject } from '../src/source/node.js'
import { createTypstSourceEditor } from '../src/tiptap/source-editor.js'

const nodes = (node: JSONContent): JSONContent[] => [node, ...(node.content ?? []).flatMap(nodes)]

describe('source preservation across independently authored scope and trivia', () => {
	it.each([
		['#let text(..args) = [REPLACEMENT]', { color: 'red' }],
		['#let red = blue', { color: 'red' }],
		['#let rgb(..args) = blue', { color: '#ff0000' }],
	])('rejects generating a style call under the shadowing declaration %s', (declaration, attrs) => {
		const source = `${declaration}\n\nHello`
		const project = createTypstSourceProject({ files: { 'main.typ': source } })
		const projection = project.open('main.typ')
		const document = structuredClone(projection.document)
		nodes(document).find((node) => node.text === 'Hello')!.marks = [{ type: 'textStyle', attrs }]
		const result = project.edit({ projection, document })
		expect(result).toMatchObject({ ok: false, issues: [{ code: 'UNSUPPORTED_EDIT' }] })
		expect(project.snapshot().files['main.typ']).toBe(source)
		expect(project.revision).toBe(0)
	})

	it.each(['#let right = left', '#let par(..args) = [REPLACEMENT]'])(
		'rejects generating alignment under the shadowing declaration %s',
		(declaration) => {
			const source = `${declaration}\n\nHello`
			const project = createTypstSourceProject({ files: { 'main.typ': source } })
			const projection = project.open('main.typ')
			const document = structuredClone(projection.document)
			document.content!.at(-1)!.attrs = { textAlign: 'right' }
			expect(project.edit({ projection, document })).toMatchObject({
				ok: false,
				issues: [{ code: 'UNSUPPORTED_EDIT' }],
			})
			expect(project.snapshot().files['main.typ']).toBe(source)
		},
	)

	it('tracks nested inline declarations without leaking their scope outside the content block', () => {
		const source =
			'#strong[#let text(..args) = [REPLACEMENT]\n#text(fill: red)[Hidden]]\n\n#text(fill: blue)[Visible]'
		const project = createTypstSourceProject({ files: { 'main.typ': source } })
		const projected = nodes(project.open('main.typ').document)
		expect(projected.some((node) => node.text === 'Hidden')).toBe(false)
		expect(projected).toContainEqual(
			expect.objectContaining({
				type: 'typstInlineSource',
				attrs: expect.objectContaining({ source: '#text(fill: red)[Hidden]' }),
			}),
		)
		expect(projected).toContainEqual(
			expect.objectContaining({
				text: 'Visible',
				marks: [{ type: 'textStyle', attrs: { color: 'blue' } }],
			}),
		)
	})

	it.each([
		['#align(center)[/* keep */Hello/* tail */]', '/* keep */Hello/* tail */'],
		['#align(center)[// keep\nHello]', '// keep\nHello'],
		[
			'#align(start)[/* before */#set par(justify: true)\nHello/* after */]',
			'/* before */\nHello/* after */',
		],
	])('retains body trivia when removing the alignment from %s', (source, expected) => {
		const project = createTypstSourceProject({ files: { 'main.typ': source } })
		const projection = project.open('main.typ')
		const document = structuredClone(projection.document)
		delete document.content![0]!.attrs!.textAlign
		expect(project.edit({ projection, document }).ok).toBe(true)
		expect(project.snapshot().files['main.typ']).toBe(expected)
	})

	it('edits confirmed prose while retaining an unrelated invalid source range byte for byte', () => {
		const invalid = '#let broken = ('
		const project = createTypstSourceProject({ files: { 'main.typ': `Hello\n\n${invalid}` } })
		const projection = project.open('main.typ')
		const document = structuredClone(projection.document)
		nodes(document).find((node) => node.text === 'Hello')!.text = 'Hello 中文😀'
		const result = project.edit({ projection, document })
		expect(result.ok).toBe(true)
		expect(project.snapshot().files['main.typ']).toBe(`Hello 中文😀\n\n${invalid}`)
		const after = project.open('main.typ')
		expect(after.diagnostics).toHaveLength(projection.diagnostics.length)
		const shift = new TextEncoder().encode(' 中文😀').length
		expect(after.diagnostics[0]).toMatchObject({
			message: projection.diagnostics[0]!.message,
			from: projection.diagnostics[0]!.from + shift,
			to: projection.diagnostics[0]!.to + shift,
		})
	})

	it('does not treat a changed invalid source range as a retained pre-existing diagnostic', () => {
		const source = 'Hello\n\n#let broken = ('
		const project = createTypstSourceProject({ files: { 'main.typ': source } })
		const projection = project.open('main.typ')
		const document = structuredClone(projection.document)
		nodes(document).find((node) => node.attrs?.role === 'invalid')!.attrs!.source =
			'#let broken = ['
		expect(project.edit({ projection, document })).toMatchObject({
			ok: false,
			issues: [{ code: 'SYNTAX_ERROR' }],
		})
		expect(project.snapshot().files['main.typ']).toBe(source)
	})

	it('keeps the invalid range and project history through a native editor prose change', () => {
		const source = 'Hello\n\n#let broken = ('
		const project = createTypstSourceProject({ files: { 'main.typ': source } })
		const editor = createTypstSourceEditor({ project, path: 'main.typ' })
		try {
			editor.commands.insertContentAt(1, { type: 'text', text: 'Edited ' })
			expect(project.snapshot().files['main.typ']).toBe(`Edited ${source}`)
			expect(nodes(editor.getJSON())).toContainEqual(
				expect.objectContaining({
					attrs: expect.objectContaining({ source: '#let broken = (', role: 'invalid' }),
				}),
			)
			expect(editor.commands.undo()).toBe(true)
			expect(project.snapshot().files['main.typ']).toBe(source)
		} finally {
			editor.destroy()
		}
	})
})

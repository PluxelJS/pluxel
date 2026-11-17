import { expect, it } from 'vitest'
import {
	createTypstSourceProject,
	findTypstEditorPosition,
	findTypstSourcePosition,
} from '../src/source/node'
import { typstSourceLibrary } from '../src/source/library.js'

it('maps UTF-8 source spans, native UTF-16 columns and editor positions without splitting Unicode', () => {
	const source = '// 注释\r\n\r\n中文😀é和\\*转义。\r\n'
	const projection = createTypstSourceProject({ files: { 'sections/a.typ': source } }).open(
		'sections/a.typ',
	)
	const paragraph = projection.document.content!.find((node) => node.type === 'paragraph')!
	expect(paragraph.content!.map((node) => node.text ?? '').join('')).toBe('中文😀é和*转义。')
	const base = projection.mapping.find((entry) => entry.kind === 'text')!.position
	for (const [column, position] of [
		[1, base],
		[2, base + 1],
		[3, base + 2],
		[5, base + 4],
		[6, base + 5],
		[7, base + 6],
		[8, base + 7],
		[10, base + 8],
	]) {
		const point = { path: 'sections/a.typ', line: 3, column }
		expect(findTypstEditorPosition({ projection, sourcePosition: point })).toBe(position)
		expect(findTypstSourcePosition({ projection, position })).toEqual(point)
	}
	expect(
		findTypstEditorPosition({
			projection,
			sourcePosition: { path: projection.path, line: 3, column: 4 },
		}),
	).toBeUndefined()
	expect(
		findTypstEditorPosition({
			projection,
			sourcePosition: { path: 'different.typ', line: 3, column: 1 },
		}),
	).toBeUndefined()
	expect(
		findTypstEditorPosition({
			projection,
			sourcePosition: { path: projection.path, line: 99, column: 1 },
		}),
	).toBeUndefined()
	expect(projection).not.toHaveProperty('parsed')
	expect(projection).not.toHaveProperty('origins')
})

it('locates expression atoms inside the native span after the markup hash', () => {
	const source =
		'#import "lib/pluxel.typ" as report\n公司：#report.field(json("data.json"), ("company",))。\n\n#upper("q3")\n'
	const projection = createTypstSourceProject({
		files: {
			'body.typ': source,
			'lib/pluxel.typ': typstSourceLibrary,
			'data.json': '{"company":"公司"}',
		},
	}).open('body.typ')
	for (const expression of ['report.field', 'upper']) {
		const offset = source.indexOf(`#${expression}`)
		const byte = new TextEncoder().encode(source.slice(0, offset)).length
		const atom = projection.mapping.find((entry) => entry.kind !== 'text' && entry.from === byte)!
		expect(atom).toBeDefined()
		const lines = source.slice(0, offset + 1).split('\n')
		const position = findTypstSourcePosition({ projection, position: atom.position })!
		expect(position).toEqual({
			path: 'body.typ',
			line: lines.length,
			column: lines.at(-1)!.length + 1,
		})
		expect(findTypstEditorPosition({ projection, sourcePosition: position })).toBe(atom.position)
	}
})

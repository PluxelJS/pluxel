import { expect, it } from 'vitest'
import {
	createTypstSourceProject,
	findTypstEditorPosition,
	findTypstSourcePosition,
} from '../src/source/node'

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

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import runTypst from '../src/worker.ts'

it.each([
	['markup', 'A😀B ffi', ['A', '😀', 'B', ' ', 'ffi']],
	[
		'string',
		String.raw`#"A😀B ffi \"Q\" \\ z"`,
		['A', '😀', 'B', ' ', 'ffi', ' ', '\\"', 'Q', '\\"', ' ', '\\\\', ' ', 'z'],
	],
	[
		'text',
		String.raw`#text("A😀B ffi \"Q\" \\ z")`,
		['A', '😀', 'B', ' ', 'ffi', ' ', '\\"', 'Q', '\\"', ' ', '\\\\', ' ', 'z'],
	],
	[
		'raw',
		String.raw`#raw("A😀B \"Q\" \\ z")`,
		['A', '😀', 'B', ' ', '\\"', 'Q', '\\"', ' ', '\\\\', ' ', 'z'],
	],
	['unicode escape', String.raw`#text("A\u{1f600}B")`, ['A', '\\u{1f600}', 'B']],
	['markup escape', String.raw`A\#B\u{1f600}C`, ['A', '\\#', 'B', '\\u{1f600}', 'C']],
])('maps real %s glyphs to their source characters', async (_name, source, expected) => {
	const root = await mkdtemp(join(tmpdir(), 'typst-native-navigation-'))
	try {
		await writeFile(join(root, 'main.typ'), `#set text(font: "DejaVu Sans")\n${source}`)
		const compiled = runTypst({
			root,
			entry: 'main.typ',
			revision: 1,
			maxOutputBytes: 32 * 1024 * 1024,
			bindingPath: fileURLToPath(new URL('../native/compiler.node', import.meta.url)),
		})
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
		const points = compiled.navigation.points
		expect(points.every((point) => point.line === 2 && point.endLine === 2)).toBe(true)
		expect(points.map((point) => source.slice(point.column - 1, point.endColumn - 1))).toEqual(
			expected,
		)
		expect(points.every((point) => point.endColumn > point.column)).toBe(true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('keeps computed text atomic instead of inventing character positions in its expression', async () => {
	const root = await mkdtemp(join(tmpdir(), 'typst-native-expression-'))
	const source = '#text(str(123456789))'
	try {
		await writeFile(join(root, 'main.typ'), source)
		const compiled = runTypst({
			root,
			entry: 'main.typ',
			revision: 1,
			maxOutputBytes: 32 * 1024 * 1024,
			bindingPath: fileURLToPath(new URL('../native/compiler.node', import.meta.url)),
		})
		expect(compiled.ok).toBe(true)
		if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
		expect(compiled.navigation.points).toHaveLength(9)
		expect(
			compiled.navigation.points.every(
				(point) => point.column === 2 && point.endColumn === source.length + 1,
			),
		).toBe(true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

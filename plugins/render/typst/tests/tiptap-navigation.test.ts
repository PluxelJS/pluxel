import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getSchema, type JSONContent } from '@tiptap/core'
import { expect, it } from 'vitest'
import {
	createTypstExtensions,
	generateTypstRegions,
	findTypstGeneratedPosition,
	findTypstRegionPosition,
	type TypstEditorConfig,
} from '../src/tiptap/index.js'
import { pointAtSource } from '../src/browser/navigation.js'
import runTypst from '../src/worker.ts'

it('maps actual glyphs to characters after escapes, emoji, nested cells and repeated raw lines', async () => {
	const root = await mkdtemp(join(tmpdir(), 'typst-character-navigation-'))
	try {
		const config: TypstEditorConfig = {
			regions: [{ id: 'body' }],
			fields: [{ path: ['name'], label: 'Name' }],
		}
		const text = (value: string): JSONContent => ({ type: 'text', text: value })
		const paragraph = (value: string): JSONContent => ({
			type: 'paragraph',
			content: [text(value)],
		})
		const document: JSONContent = {
			type: 'doc',
			content: [
				paragraph('Start 😀 "quoted" \\ tail\nsecond'),
				{
					type: 'table',
					content: [
						{
							type: 'tableRow',
							content: [{ type: 'tableCell', content: [paragraph('Cell middle target')] }],
						},
					],
				},
				{
					type: 'codeBlock',
					attrs: { language: 'js' },
					content: [text('same\nsame\n  `fence`\n```ticks```')],
				},
				{
					type: 'paragraph',
					content: [text('Name: '), { type: 'dataField', attrs: { path: ['name'] } }],
				},
			],
		}
		const generated = generateTypstRegions({
			regions: { body: document },
			config,
			data: { name: 'External data' },
			snapshotRevision: 1,
		})
		if (!generated.ok) throw new Error(JSON.stringify(generated.issues))
		for (const [path, value] of Object.entries({
			'main.typ':
				'#set page(width: 180pt, height: 400pt, margin: 15pt)\n#include "_editor/regions/body.typ"',
			...generated.value.templateFiles,
			...generated.value.inputFiles,
		})) {
			const destination = join(root, path.replace(/^\//, ''))
			await mkdir(dirname(destination), { recursive: true })
			await writeFile(destination, value)
		}
		const result = runTypst({
			root,
			entry: 'main.typ',
			revision: 1,
			maxOutputBytes: 8_000_000,
			bindingPath: fileURLToPath(new URL('../native/compiler.node', import.meta.url)),
		})
		if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
		const schema = getSchema(createTypstExtensions(config))
		const native = schema.nodeFromJSON(document)
		const targets: { position: number; character: string }[] = []
		let fieldPosition = -1
		native.descendants((node, position) => {
			if (node.isText) {
				let offset = 0
				for (const character of node.text!) {
					if (character.trim()) targets.push({ position: position + offset, character })
					offset += character.length
				}
			} else if (node.type.name === 'dataField') fieldPosition = position
		})
		const source = generated.value.templateFiles['_editor/regions/body.typ']!
		const sourceOffset = (point: { line: number; column: number }) =>
			source
				.split('\n')
				.slice(0, point.line - 1)
				.reduce((size, line) => size + line.length + 1, 0) +
			point.column -
			1
		for (const target of targets) {
			const position = findTypstGeneratedPosition({
				mapping: generated.value.mapping,
				navigation: result.navigation,
				regionId: 'body',
				position: target.position,
				snapshotRevision: 1,
			})
			expect(
				position,
				`Missing generated position for ${target.character} at ${target.position}`,
			).toBeDefined()
			const glyph = pointAtSource(result.navigation.points, position!, 1)!
			expect(glyph).toBeDefined()
			const restored = findTypstRegionPosition({
				mapping: generated.value.mapping,
				position: glyph,
				snapshotRevision: 1,
			})!
			// A ligature may cover several characters; its start is the valid native caret boundary.
			expect(restored.from).toBeLessThanOrEqual(target.position)
			const glyphEnd = sourceOffset({ line: glyph.endLine, column: glyph.endColumn })
			const glyphStart = sourceOffset(glyph)
			const covered = generated.value.mapping.filter(
				(entry) =>
					entry.kind === 'text' && entry.startOffset < glyphEnd && entry.endOffset > glyphStart,
			)
			expect(
				covered.some((entry) => target.position >= entry.from && target.position < entry.to),
				`Wrong glyph for ${target.character} at ${target.position}`,
			).toBe(true)
			expect(restored.from).toBe(covered[0]!.from)
		}
		const field = findTypstGeneratedPosition({
			mapping: generated.value.mapping,
			navigation: result.navigation,
			regionId: 'body',
			position: fieldPosition,
			snapshotRevision: 1,
		})!
		expect(
			findTypstRegionPosition({
				mapping: generated.value.mapping,
				position: field,
				snapshotRevision: 1,
			}),
		).toEqual({ regionId: 'body', from: fieldPosition, to: fieldPosition + 1 })
		const rawStart = native.child(0).nodeSize + native.child(1).nodeSize + 1
		const firstLine = findTypstGeneratedPosition({
			mapping: generated.value.mapping,
			navigation: result.navigation,
			regionId: 'body',
			position: rawStart + 2,
			snapshotRevision: 1,
		})!
		const secondLine = findTypstGeneratedPosition({
			mapping: generated.value.mapping,
			navigation: result.navigation,
			regionId: 'body',
			position: rawStart + 7,
			snapshotRevision: 1,
		})!
		expect(secondLine.line).toBe(firstLine.line + 1)
		expect(pointAtSource(result.navigation.points, secondLine, 1)!.y).toBeGreaterThan(
			pointAtSource(result.navigation.points, firstLine, 1)!.y,
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

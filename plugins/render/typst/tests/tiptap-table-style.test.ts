import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getSchema, type JSONContent } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { describe, expect, it } from 'vitest'
import {
	createEditorExtensions,
	createTypstExtensions,
	TypstTableStyle,
	validateTypstRegion,
	generateTypstRegions,
	exportTypstMarkdown,
	findTypstGeneratedPosition,
	findTypstRegionPosition,
	type TypstEditorConfig,
	type TypstTableAppearance,
} from '../src/tiptap/index.js'
import runTypst, { renderTypstPage } from '../src/worker.ts'

const plain: TypstEditorConfig = { regions: [{ id: 'body' }], fields: [] }
const config: TypstEditorConfig = { ...plain, extensions: [TypstTableStyle] }
const paragraph = (text: string): JSONContent => ({
	type: 'paragraph',
	content: [{ type: 'text', text }],
})
function table(style?: unknown): JSONContent {
	return {
		type: 'table',
		...(style === undefined ? {} : { attrs: { typstTableStyle: style } }),
		content: [
			{
				type: 'tableRow',
				content: ['Item', 'Amount'].map((text) => ({
					type: 'tableHeader',
					content: [paragraph(text)],
				})),
			},
			{
				type: 'tableRow',
				content: ['Alpha', '123'].map((text) => ({
					type: 'tableCell',
					content: [paragraph(text)],
				})),
			},
		],
	}
}
const document = (node: JSONContent): JSONContent => ({ type: 'doc', content: [node] })
const validate = (node: JSONContent, rules = config) =>
	validateTypstRegion({ config: rules, regionId: 'body', document: document(node) })
function generate(node: JSONContent, rules = config) {
	const result = generateTypstRegions({
		config: rules,
		regions: { body: document(node) },
		data: {},
		snapshotRevision: 1,
	})
	if (!result.ok) throw new Error(JSON.stringify(result.issues))
	return result.value
}

describe('optional Typst table appearance', () => {
	it('adds only an attribute to official table nodes; the plain kit has no Typst features', () => {
		const base = getSchema(createEditorExtensions())
		const enhanced = getSchema(createTypstExtensions(config))
		expect(base.nodes.dataField).toBeUndefined()
		expect(base.nodes.table!.spec.attrs ?? {}).not.toHaveProperty('typstTableStyle')
		expect(enhanced.nodes.table!.spec.content).toBe(base.nodes.table!.spec.content)
		expect(enhanced.nodes.tableCell!.spec.content).toBe(base.nodes.tableCell!.spec.content)
		expect(enhanced.nodes.tableCell!.spec.attrs).toEqual(base.nodes.tableCell!.spec.attrs)
		expect(enhanced.nodes.tableCell!.spec.tableRole).toBe(base.nodes.tableCell!.spec.tableRole)
		expect(enhanced.nodes.table!.spec.attrs).toHaveProperty('typstTableStyle')
		const markdown = new MarkdownManager({ extensions: createEditorExtensions() })
		const json = markdown.parse('| A | B |\n|---|---|\n| one | two |')
		base.nodeFromJSON(json).check()
		expect(markdown.serialize(json)).toContain('one')
		expect(validate(table(), plain).ok).toBe(true)
		expect(validate(table('grid'), plain)).toMatchObject({
			ok: false,
			issues: [expect.objectContaining({ code: 'UNKNOWN_ATTRIBUTE' })],
		})
	})

	it('validates template defaults and rejects disallowed overrides before generation', () => {
		for (const style of [null, 'grid', 'grid-open-sides', 'three-line', 'borderless'])
			expect(validate(table(style)).ok).toBe(true)
		for (const style of ['', 'inherit', 'none', 4, { stroke: 'none' }])
			expect(validate(table(style)).ok).toBe(false)
		const locked = {
			...plain,
			extensions: [TypstTableStyle.configure({ defaultStyle: 'three-line', allowedStyles: [] })],
		}
		expect(validate(table(null), locked).ok).toBe(true)
		expect(validate(table('borderless'), locked)).toMatchObject({ ok: false })
		expect(generate(table(null), locked).templateFiles['_editor/regions/body.typ']).toContain(
			'stroke: none',
		)
		const invalid = {
			...plain,
			extensions: [TypstTableStyle.configure({ defaultStyle: 'wrong' as TypstTableAppearance })],
		}
		expect(validate(table(), invalid)).toMatchObject({
			ok: false,
			issues: [{ code: 'INVALID_CONFIG', message: expect.any(String) }],
		})
		// Missing configuration leaves existing Typst template set rules intact.
		expect(generate(table(null)).templateFiles['_editor/regions/body.typ']).not.toContain('stroke:')
	})

	it('reports Markdown style loss; deliberate Markdown projection can reopen without the addon', () => {
		const result = exportTypstMarkdown({
			config,
			regionId: 'body',
			document: document(table('three-line')),
		})
		if (!result.ok) throw new Error(JSON.stringify(result.issues))
		expect(result.value.lossless).toBe(false)
		expect(result.value.issues).toContainEqual(
			expect.objectContaining({
				code: 'COMPLEX_CONTENT',
				path: ['content', 0, 'attrs', 'typstTableStyle'],
			}),
		)
		const markdown = new MarkdownManager({ extensions: createEditorExtensions() })
		const restored = getSchema(createEditorExtensions()).nodeFromJSON(
			markdown.parse(result.value.markdown),
		)
		expect(restored.textContent).toBe('ItemAmountAlpha123')
		expect(restored.firstChild!.attrs).not.toHaveProperty('typstTableStyle')
		const inherited = exportTypstMarkdown({
			config,
			regionId: 'body',
			document: document(table(null)),
		})
		expect(inherited).toMatchObject({ ok: true, value: { lossless: true } })
	})

	it('compiles all appearances with merged multi-row headers and retains character navigation', async () => {
		const root = await mkdtemp(join(tmpdir(), 'typst-table-style-'))
		try {
			const bindingPath = fileURLToPath(new URL('../native/compiler.node', import.meta.url))
			const openSidesMatches: boolean[] = []
			for (const style of ['grid', 'grid-open-sides', 'three-line', 'borderless'] as const) {
				const cell = (text: string, attrs?: Record<string, number>, header = false) => ({
					type: header ? 'tableHeader' : 'tableCell',
					...(attrs ? { attrs } : {}),
					content: [paragraph(text)],
				})
				const node: JSONContent = {
					type: 'table',
					attrs: { typstTableStyle: style },
					content: [
						[cell('Group', { colspan: 3 }, true)],
						['Item', 'Amount', 'Target'].map((text) => cell(text, undefined, true)),
						[cell('Alpha', { rowspan: 2 }), cell('Shared', { colspan: 2 })],
						[cell('123'), cell('Right', { rowspan: 2 })],
						[cell('Combined', { colspan: 2 })],
					].map((content) => ({ type: 'tableRow', content })),
				}
				const generated = generate(node)
				for (const [path, value] of Object.entries({
					'main.typ':
						'#set page(width: 240pt, height: 300pt, margin: 20pt)\n#include "_editor/regions/body.typ"',
					...generated.templateFiles,
					...generated.inputFiles,
				})) {
					const destination = join(root, path.replace(/^\//, ''))
					await mkdir(dirname(destination), { recursive: true })
					await writeFile(destination, value)
				}
				const compiled = runTypst({
					root,
					entry: 'main.typ',
					revision: 1,
					maxOutputBytes: 8_000_000,
					bindingPath,
				})
				if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
				expect(Buffer.from(compiled.pdf).subarray(0, 5).toString()).toBe('%PDF-')
				let caret = -1
				getSchema(createTypstExtensions(config))
					.nodeFromJSON(document(node))
					.descendants((child, pos) => {
						if (child.text === 'Alpha') caret = pos + 2
					})
				const point = findTypstGeneratedPosition({
					mapping: generated.mapping,
					navigation: compiled.navigation,
					regionId: 'body',
					position: caret,
					snapshotRevision: 1,
				})!
				expect(
					findTypstRegionPosition({
						mapping: generated.mapping,
						position: point,
						snapshotRevision: 1,
					}),
				).toMatchObject({ from: caret })
				const expectedImage = renderTypstPage({
					kind: 'render',
					revision: 1,
					page: 1,
					scale: 1,
					maxOutputBytes: 8_000_000,
				}).data
				// An explicit preset must also override cell/line defaults in the author template.
				await writeFile(
					join(root, 'main.typ'),
					'#set page(width: 240pt, height: 300pt, margin: 20pt)\n' +
						'#set table.cell(stroke: 2pt + red)\n#set table.hline(stroke: 3pt + blue)\n' +
						'#include "_editor/regions/body.typ"',
				)
				const withTemplateRules = runTypst({
					root,
					entry: 'main.typ',
					revision: 2,
					maxOutputBytes: 8_000_000,
					bindingPath,
				})
				if (!withTemplateRules.ok) throw new Error(JSON.stringify(withTemplateRules.diagnostics))
				const actualImage = renderTypstPage({
					kind: 'render',
					revision: 2,
					page: 1,
					scale: 1,
					maxOutputBytes: 8_000_000,
				}).data
				expect(Buffer.from(actualImage).equals(Buffer.from(expectedImage))).toBe(true)
				if (style === 'grid-open-sides') {
					// Independent native oracle: erase only the two outer vertical lines of a full grid.
					// In particular, a row's first/last DOM child is not necessarily an outer cell.
					const fullGrid = generate({ ...node, attrs: { typstTableStyle: 'grid' } })
					const reference = fullGrid.templateFiles['_editor/regions/body.typ']!.replace(
						/(columns: \([^\n]+\),\n)/,
						'$1table.vline(x: 0, stroke: none), table.vline(x: 3, stroke: none),\n',
					)
					await writeFile(join(root, '_editor/regions/body.typ'), reference)
					const referenceCompiled = runTypst({
						root,
						entry: 'main.typ',
						revision: 3,
						maxOutputBytes: 8_000_000,
						bindingPath,
					})
					if (!referenceCompiled.ok) throw new Error(JSON.stringify(referenceCompiled.diagnostics))
					const referenceImage = renderTypstPage({
						kind: 'render',
						revision: 3,
						page: 1,
						scale: 1,
						maxOutputBytes: 8_000_000,
					}).data
					openSidesMatches.push(Buffer.from(actualImage).equals(Buffer.from(referenceImage)))
				}
			}
			expect(openSidesMatches).toEqual([true])
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})

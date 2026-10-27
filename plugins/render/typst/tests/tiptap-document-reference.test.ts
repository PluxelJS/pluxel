import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSchema, type JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { loadNativeCompiler } from '../src/native-binding.ts'
import {
	createTypstExtensions,
	generateTypstRegions,
	validateTypstRegion,
	type TypstEditorConfig,
} from '../src/tiptap/index.js'

const config: TypstEditorConfig = { regions: [{ id: 'objects' }, { id: 'references' }], fields: [] }
const text = (value: string): JSONContent => ({ type: 'text', text: value })
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const reference = (target: string, showCaption: boolean | null = null): JSONContent => ({
	type: 'reference',
	attrs: { target, showCaption },
})
const figure = (id: string, caption: JSONContent[]): JSONContent => ({
	type: 'figure',
	attrs: { id, label: `tbl:${id}` },
	content: [
		{
			type: 'table',
			content: [
				{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(text('Cell'))] }] },
			],
		},
		{ type: 'figureCaption', content: caption },
	],
})

async function compile(regions: Record<string, JSONContent>, template: string) {
	const result = generateTypstRegions({ regions, config, data: {}, snapshotRevision: 1 })
	if (!result.ok) throw new Error(JSON.stringify(result.issues))
	const root = await mkdtemp(join(tmpdir(), 'typst-reference-caption-'))
	try {
		for (const [path, content] of Object.entries({
			...result.value.templateFiles,
			...result.value.inputFiles,
			'main.typ': template,
		})) {
			const output = join(root, path.replace(/^\//, ''))
			await mkdir(dirname(output), { recursive: true })
			await writeFile(output, content)
		}
		const compiler = loadNativeCompiler(
			fileURLToPath(new URL('../native/compiler.node', import.meta.url)),
		).create({ workspace: root })
		const compiled = compiler.compile({ mainFilePath: join(root, 'main.typ') })
		const diagnostics = [compiled.takeDiagnostics(), compiled.takeWarnings()].flatMap((value) =>
			value ? compiler.fetchDiagnostics(value) : [],
		)
		expect(diagnostics).toEqual([])
		expect(compiled.result).toBeDefined()
		const svg = compiler.svg(compiled.result!)
		const rendered = [...svg.matchAll(/<h5:div class="tsel"[^>]*>(.*?)<\/h5:div>/g)]
			.map((match) => match[1])
			.join('')
			.replaceAll(/\s/g, '')
		const links = [...svg.matchAll(/handleTypstLocation\(this, ([^)]+)\)/g)].map(
			(match) => match[1],
		)
		return { rendered, links, metadata: compiler.query(compiled.result!, { selector: 'metadata' }) }
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

describe('reference caption policy', () => {
	it('defaults to the template and rejects non-boolean overrides without coercion', () => {
		const schema = getSchema(createTypstExtensions(config))
		expect(schema.nodes.reference!.create({ target: 'first' }).attrs.showCaption).toBeNull()
		for (const showCaption of [null, true, false]) {
			expect(
				validateTypstRegion({
					config,
					regionId: 'references',
					document: doc(paragraph(reference('first', showCaption))),
				}).ok,
			).toBe(true)
		}
		for (const showCaption of ['true', 0, {}]) {
			expect(
				validateTypstRegion({
					config,
					regionId: 'references',
					document: doc(paragraph({ type: 'reference', attrs: { target: 'first', showCaption } })),
				}),
			).toMatchObject({ ok: false, issues: [{ code: 'INVALID_ATTRIBUTE' }] })
		}
	})

	it('keeps template defaults importable even when the document has no references', async () => {
		const result = await compile(
			{ objects: doc(paragraph(text('No references'))), references: doc(paragraph()) },
			'#import "_editor/references.typ": reference-caption\n#reference-caption.update(true)\n#include "_editor/regions/objects.typ"\n#include "_editor/regions/references.typ"',
		)
		expect(result.rendered).toContain('Noreferences')
	})

	it('uses template state across includes, explicit overrides, current captions and native links/show rules', async () => {
		for (const enabled of [false, true]) {
			const caption = enabled ? 'Revised' : 'Original'
			const result = await compile(
				{
					objects: doc(
						figure('first', [{ ...text(caption), marks: [{ type: 'bold' }] }]),
						figure('empty', []),
						{ type: 'blockMath', attrs: { id: 'eq', label: 'eq:x', latex: 'x = 1' } },
					),
					references: doc(
						paragraph(text('AUTO:'), reference('first'), text(':END')),
						paragraph(text('ON:'), reference('first', true), text(':END')),
						paragraph(text('OFF:'), reference('first', false), text(':END')),
						paragraph(text('EMPTY:'), reference('empty', true), text(':END')),
						paragraph(text('EQ:'), reference('eq', true), text(':END')),
					),
				},
				[
					'#set text(lang: "en")',
					'#set figure(supplement: [Object])',
					'#set math.equation(numbering: "(1)")',
					'#show ref: it => strong([REF/#it])',
					'#import "_editor/references.typ": reference-caption',
					enabled ? '#reference-caption.update(true)' : '',
					'#include "_editor/regions/objects.typ"',
					'#include "_editor/regions/references.typ"',
				].join('\n'),
			)
			expect(result.rendered).toContain(`AUTO:REF/Object1${enabled ? `「${caption}」` : ''}:END`)
			expect(result.rendered).toContain(`ON:REF/Object1「${caption}」:END`)
			expect(result.rendered).toContain('OFF:REF/Object1:END')
			expect(result.rendered).toContain('EMPTY:REF/Object2:END')
			expect(result.rendered).toContain('EQ:REF/Equation1:END')
			// The native number and the appended caption each point to the same target.
			expect(result.links).toHaveLength(enabled ? 7 : 6)
			expect(result.links[0]).toBe(result.links[1])
			expect(result.links[1]).toBe(result.links[2])
		}
	})

	it('keeps self and mutual caption references short inside appended captions and preserves unrelated metadata', async () => {
		const result = await compile(
			{
				objects: doc(
					figure('first', [text('Alpha '), reference('first'), text(' and '), reference('second')]),
					figure('second', [text('Beta '), reference('first')]),
				),
				references: doc(paragraph(text('RESULT:'), reference('first'), text(':END'))),
			},
			[
				'#set text(lang: "en")',
				'#import "_editor/references.typ": reference-caption, render-reference',
				'#show metadata: render-reference',
				'#reference-caption.update(true)',
				'#include "_editor/regions/objects.typ"',
				'#include "_editor/regions/references.typ"',
				'#metadata((consumer: "unrelated"))',
			].join('\n'),
		)
		expect(result.rendered).toContain('RESULT:Table1「AlphaTable1andTable2」:END')
		expect(result.metadata).toContainEqual(
			expect.objectContaining({ value: { consumer: 'unrelated' } }),
		)
		expect(result.links.length).toBeGreaterThan(3)
	})
})

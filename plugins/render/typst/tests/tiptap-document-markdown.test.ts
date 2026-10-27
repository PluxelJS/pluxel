import { getSchema, type JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import {
	createTypstExtensions,
	exportTypstMarkdown,
	parseTypstMarkdown,
	type TypstEditorConfig,
} from '../src/tiptap/index.js'

const config: TypstEditorConfig = { regions: [{ id: 'analysis' }], fields: [] }
const options = { config, regionId: 'analysis', format: 'agent' as const }
const text = (value: string): JSONContent => ({ type: 'text', text: value })
const paragraph = (value: string): JSONContent => ({ type: 'paragraph', content: [text(value)] })
const figure: JSONContent = {
	type: 'figure',
	attrs: { id: 'revenue-table', label: 'tbl:revenue' },
	content: [
		{
			type: 'table',
			content: [
				{ type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph('渠道')] }] },
				{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('企业服务')] }] },
			],
		},
		{
			type: 'figureCaption',
			content: [text('季度收入 '), { ...text('2026'), marks: [{ type: 'bold' }] }],
		},
	],
}
const equation: JSONContent = {
	type: 'blockMath',
	attrs: { id: 'growth-equation', label: 'eq:growth', latex: 'g = \\frac{v_1-v_0}{v_0}' },
}
const document: JSONContent = {
	type: 'doc',
	content: [
		figure,
		equation,
		{
			type: 'paragraph',
			content: [
				text('增长率 '),
				{ type: 'inlineMath', attrs: { latex: 'g' } },
				text(' 见 '),
				{ type: 'reference', attrs: { target: 'growth-equation' } },
				text('；数据见 '),
				{ type: 'reference', attrs: { target: 'revenue-table' } },
			],
		},
	],
}

describe('document objects in agent Markdown', () => {
	it('preserves identities and rich captions while leaving tables and LaTeX editable', () => {
		const schema = getSchema(createTypstExtensions(config))
		const exported = exportTypstMarkdown({ ...options, document })
		if (!exported.ok) throw new Error(JSON.stringify(exported.issues))
		expect(exported.value.lossless).toBe(true)
		const markdown = exported.value.markdown
		expect(markdown).toContain('figure ')
		expect(markdown).toContain(':::caption')
		expect(markdown).toContain('**2026**')
		expect(markdown).toMatch(/\| 渠道 +\|/)
		expect(markdown).toContain('\\frac{v_1-v_0}{v_0}')
		expect(markdown).toContain('[ref {"target":"growth-equation"}]')
		expect(markdown).not.toContain(':::tiptap')
		const parsed = parseTypstMarkdown({ ...options, markdown })
		if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
		expect(schema.nodeFromJSON(parsed.value).eq(schema.nodeFromJSON(document))).toBe(true)

		const edited = parseTypstMarkdown({
			...options,
			markdown: markdown.replace('季度收入', '年度收入').replace('v_1-v_0', 'v_2-v_0'),
		})
		if (!edited.ok) throw new Error(JSON.stringify(edited.issues))
		expect(edited.value.content![0]!.attrs).toMatchObject(figure.attrs!)
		expect(edited.value.content![0]!.content![1]!.content![0]!.text).toBe('年度收入 ')
		expect(edited.value.content![1]!.attrs).toMatchObject({
			id: 'growth-equation',
			label: 'eq:growth',
			latex: 'g = \\frac{v_2-v_0}{v_0}',
		})
	})

	it('imports ordinary inline and display math without inventing labels or identities', () => {
		const parsed = parseTypstMarkdown({
			...options,
			markdown: 'Value $x^2$ follows.\n\n$$\n\\frac{a}{b}\n$$',
		})
		if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
		expect(parsed.value.content![0]!.content).toContainEqual({
			type: 'inlineMath',
			attrs: { latex: 'x^2' },
		})
		expect(parsed.value.content![1]).toMatchObject({
			type: 'blockMath',
			attrs: { latex: '\\frac{a}{b}' },
		})
		expect(parsed.value.content![1]!.attrs?.label ?? null).toBeNull()
	})

	it('round-trips per-reference caption overrides separately from target identity', () => {
		for (const showCaption of [null, true, false]) {
			const attrs = { target: 'revenue-table', showCaption }
			const referenceDocument: JSONContent = {
				type: 'doc',
				content: [{ type: 'paragraph', content: [{ type: 'reference', attrs }] }],
			}
			const exported = exportTypstMarkdown({ ...options, document: referenceDocument })
			if (!exported.ok) throw new Error(JSON.stringify(exported.issues))
			expect(exported.value.markdown).toContain(`[ref ${JSON.stringify(attrs)}]`)
			const parsed = parseTypstMarkdown({ ...options, markdown: exported.value.markdown })
			if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
			expect(parsed.value.content![0]!.content![0]!.attrs).toEqual(attrs)
		}
	})

	it('rejects malformed object syntax instead of flattening it into ordinary text', () => {
		for (const markdown of [
			':::figure []\nbody\n:::',
			':::figure {"id":"figure-one","label":"fig:one"}\nbody',
			'::::figure {}\n![chart](asset)\n\n:::caption\nfirst\n\nsecond\n:::\n::::',
			'[ref {"target":17}]',
			'[ref {"target":"growth-equation","number":3}]',
			'[ref {"target":"growth-equation","showCaption":"true"}]',
		])
			expect(parseTypstMarkdown({ ...options, markdown })).toMatchObject({ ok: false })
	})

	it('keeps reference and figure examples inside code literal', () => {
		const source = ':::figure {}\n[ref {"target":"example"}]\n$$x$$\n:::'
		const parsed = parseTypstMarkdown({ ...options, markdown: `\`\`\`markdown\n${source}\n\`\`\`` })
		if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
		expect(parsed.value.content![0]).toMatchObject({ type: 'codeBlock', content: [text(source)] })
	})
})

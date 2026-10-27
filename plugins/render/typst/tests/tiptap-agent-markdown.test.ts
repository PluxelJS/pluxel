import { getSchema, type Editor, type JSONContent } from '@tiptap/core'
import { history, undo } from '@tiptap/pm/history'
import { EditorState } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import {
	applyTypstCandidate,
	createTypstExtensions,
	exportTypstMarkdown,
	generateTypstRegions,
	parseTypstMarkdown,
	prepareTypstCandidate,
	TypstSource,
	TypstTableStyle,
	TypstTemplateBlock,
	type TypstEditorConfig,
} from '../src/tiptap/index.js'

const config: TypstEditorConfig = {
	regions: [{ id: 'body' }],
	fields: [{ path: ['customer', 'name'], label: 'Customer' }],
	extensions: [
		TypstTableStyle,
		TypstSource,
		TypstTemplateBlock.configure({
			templates: [
				{
					id: 'summary',
					label: 'Summary',
					source: '#heading(level: 2)[#props.title: #data.name]',
					validateProps: (props) => typeof props.title === 'string',
					defaults: { title: 'Summary' },
				},
			],
		}),
	],
}
const data = { customer: { name: '客户😀' } }
const options = { config, regionId: 'body', data, format: 'agent' as const }
const schema = getSchema(createTypstExtensions(config))
const document = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const paragraph = (text: string): JSONContent => ({
	type: 'paragraph',
	content: [{ type: 'text', text }],
})
const styled = (attrs: Record<string, unknown>, text = '重要内容'): JSONContent =>
	document({
		type: 'paragraph',
		content: [{ type: 'text', text, marks: [{ type: 'textStyle', attrs }] }],
	})
const native = (value: JSONContent) => schema.nodeFromJSON(value).toJSON()
const rawBlock = (value: unknown) => `:::tiptap\n${JSON.stringify(value)}\n:::`
const parse = (markdown: string) => parseTypstMarkdown({ ...options, markdown })
const parsedDocument = (markdown: string): JSONContent => {
	const parsed = parse(markdown)
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
	return parsed.value
}

function roundTrip(value: JSONContent): string {
	const initial = structuredClone(value)
	const exported = exportTypstMarkdown({ ...options, document: value })
	if (!exported.ok) throw new Error(JSON.stringify(exported.issues))
	expect(exported.value).toMatchObject({ lossless: true, issues: [] })
	expect(native(parsedDocument(exported.value.markdown))).toEqual(native(value))
	expect(value).toEqual(initial)
	return exported.value.markdown
}

const component: JSONContent = {
	type: 'templateBlock',
	attrs: {
		id: 'summary-1',
		template: 'summary',
		props: {
			title: '本期摘要',
			extra: { type: 'html', task: true, channels: ['direct', 'partner'] },
		},
		dataPath: ['customer'],
	},
}
const table: JSONContent = {
	type: 'table',
	attrs: { tableStyle: 'three-line' },
	content: [
		{
			type: 'tableRow',
			content: [
				{
					type: 'tableHeader',
					attrs: { colspan: 2, colwidth: [120, 180] },
					content: [paragraph('收入')],
				},
			],
		},
		{
			type: 'tableRow',
			content: [
				{
					type: 'tableCell',
					attrs: { colwidth: [120] },
					content: [paragraph('直销'), paragraph('含续订')],
				},
				{
					type: 'tableCell',
					attrs: { colwidth: [180] },
					content: [paragraph('120')],
				},
			],
		},
	],
}

describe('agent Markdown style and field annotations', () => {
	it('round-trips each native style attribute and their combination without HTML', () => {
		for (const attrs of [
			{ fontFamily: 'Noto Serif CJK SC' },
			{ fontFamily: '"DIN 1451"' },
			{ fontSize: '12pt' },
			{ color: '#f00' },
			{ backgroundColor: '#fff' },
			{
				fontFamily: 'Noto Serif CJK SC',
				fontSize: '12pt',
				color: '#f00',
				backgroundColor: '#fff',
			},
		]) {
			const markdown = roundTrip(styled(attrs))
			expect(markdown).toContain('[textStyle ')
			expect(markdown).toContain('[/textStyle]')
			expect(markdown).not.toContain('<span')
			const imported = parsedDocument(`[textStyle ${JSON.stringify(attrs)}]重要内容[/textStyle]`)
			expect(native(imported)).toEqual(native(styled(attrs)))
		}
	})

	it('combines annotations with official bold and italic syntax', () => {
		const imported = parsedDocument('[textStyle {"color":"#f00"}]**重点**与*说明*[/textStyle]')
		const content = imported.content![0]!.content!
		expect(content.find((node) => node.text === '重点')?.marks).toEqual(
			expect.arrayContaining([{ type: 'bold' }, expect.objectContaining({ type: 'textStyle' })]),
		)
		expect(content.find((node) => node.text === '说明')?.marks).toEqual(
			expect.arrayContaining([{ type: 'italic' }, expect.objectContaining({ type: 'textStyle' })]),
		)
		roundTrip(imported)
	})

	it('preserves styled whitespace, Unicode text and a styled live field atom', () => {
		for (const text of [' ', '  边界空白  ', '\t', '😀 e\u0301'])
			expect(roundTrip(styled({ color: '#f00', backgroundColor: '#fff' }, text))).not.toContain(
				':::tiptap',
			)
		const imported = parsedDocument(
			'客户：[textStyle {"fontSize":"12pt","color":"#f00"}][dataField {"path":["customer","name"]}][/textStyle]。',
		)
		const field = imported.content![0]!.content!.find((node) => node.type === 'dataField')!
		expect(field).toMatchObject({
			attrs: { path: ['customer', 'name'] },
			marks: [
				expect.objectContaining({ type: 'textStyle', attrs: { fontSize: '12pt', color: '#f00' } }),
			],
		})
		const markdown = roundTrip(imported)
		expect(markdown).toContain('[dataField ')
		expect(markdown).not.toContain(':::tiptap')
		expect(markdown).not.toContain('客户😀')
		expect(markdown).not.toContain('<data-field')
		const unstyled = parsedDocument('[dataField {"path":["customer","name"]}]')
		expect(roundTrip(unstyled)).toContain('[dataField ')
	})

	it('continues to produce Typst colors and live bindings from imported agent text', () => {
		const imported = parsedDocument(
			'[textStyle {"color":"#f00","backgroundColor":"#fff"}][dataField {"path":["customer","name"]}][/textStyle]',
		)
		const generated = generateTypstRegions({
			config,
			regions: { body: imported },
			data,
			snapshotRevision: 'agent-edit:1',
		})
		if (!generated.ok) throw new Error(JSON.stringify(generated.issues))
		const source = generated.value.templateFiles['_editor/regions/body.typ']!
		expect(source).toContain('fill: rgb(255, 0, 0, 100%)')
		expect(source).toContain('#highlight(fill: rgb(255, 255, 255, 100%))')
		expect(source).not.toContain('客户😀')
		expect(JSON.parse(generated.value.inputFiles['/inputs/editor/data.json']!)).toEqual(data)
	})
})

describe('agent Markdown native JSON blocks', () => {
	it('preserves component identity, complete props, data bindings and raw Typst source', () => {
		const source: JSONContent = {
			type: 'typstSource',
			attrs: {
				id: 'source-1',
				source: '#text[Literal :::tiptap and ``` markers]\n#data.customer.name',
			},
		}
		const authored = document(paragraph('Before'), component, source, paragraph('After'))
		expect(roundTrip(authored)).toContain(':::tiptap')
		expect(native(parsedDocument(rawBlock(component)))).toEqual(native(document(component)))
	})

	it('preserves styled, merged and multi-paragraph table cells with exact column widths', () => {
		const authored = document(table)
		expect(roundTrip(authored)).toContain(':::tiptap')
		expect(native(parsedDocument(rawBlock(table)))).toEqual(native(authored))
	})

	it('uses neutral tableStyle annotations and rejects the old attribute in agent edits', () => {
		const simpleTable: JSONContent = {
			type: 'table',
			content: [
				{ type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph('Heading')] }] },
				{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('Value')] }] },
			],
		}
		for (const tableStyle of ['grid', 'grid-open-sides', 'three-line', 'borderless']) {
			const markdown = roundTrip(document({ ...simpleTable, attrs: { tableStyle } }))
			expect(markdown).toContain(`:::attrs {"tableStyle":"${tableStyle}"}`)
			expect(markdown).not.toContain('typst')
		}
		for (const markdown of [
			':::attrs {"typstTableStyle":"three-line"}\n| Heading |\n| --- |\n| Value |\n:::',
			rawBlock({ ...simpleTable, attrs: { typstTableStyle: null } }),
		])
			expect(parse(markdown)).toMatchObject({
				ok: false,
				issues: [expect.objectContaining({ code: 'UNKNOWN_ATTRIBUTE' })],
			})
	})

	it('accepts a complete doc payload and splices its blocks between ordinary Markdown', () => {
		const markdown = `Before\n\n${rawBlock(document(table, component))}\n\nAfter`
		const imported = parsedDocument(markdown)
		expect(native(imported)).toEqual(
			native(document(paragraph('Before'), table, component, paragraph('After'))),
		)
		roundTrip(imported)
	})

	it('preserves boundaries between adjacent lists that ordinary Markdown would merge', () => {
		const list = (text: string): JSONContent => ({
			type: 'bulletList',
			content: [{ type: 'listItem', content: [paragraph(text)] }],
		})
		expect(
			roundTrip({
				...document(list('First'), list('Second')),
				attrs: {},
				marks: [],
			}),
		).toContain(':::attrs {}')
	})

	it('retains Markdown prose inside aligned blocks, styled tables and nested containers', () => {
		const aligned = { ...paragraph('Centered content'), attrs: { textAlign: 'center' } }
		const simpleTable: JSONContent = {
			type: 'table',
			attrs: { tableStyle: 'three-line' },
			content: [
				{ type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph('Heading')] }] },
				{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('Value')] }] },
			],
		}
		const nested: JSONContent = {
			type: 'bulletList',
			content: [
				{
					type: 'listItem',
					content: [
						paragraph('Before component'),
						component,
						aligned,
						paragraph('After component'),
					],
				},
			],
		}
		const markdown = roundTrip(document(aligned, simpleTable, nested))
		expect(markdown).toContain(':::attrs ')
		expect(markdown).toContain('| Heading |')
		expect(markdown).toContain('- Before component')
		expect(markdown).toContain('After component')
		expect(markdown).not.toContain('"type":"bulletList"')
		expect(markdown).not.toContain('"type":"doc"')
	})

	it('keeps crossing official marks and custom link attributes local to inline text', () => {
		const markdown = roundTrip(
			document({
				type: 'paragraph',
				content: [
					{ type: 'text', text: 'A', marks: [{ type: 'bold' }] },
					{ type: 'text', text: 'B', marks: [{ type: 'bold' }, { type: 'italic' }] },
					{ type: 'text', text: 'C', marks: [{ type: 'italic' }] },
					{
						type: 'text',
						text: 'Link',
						marks: [
							{
								type: 'link',
								attrs: {
									href: 'https://example.com',
									target: '_self',
									rel: 'author',
									class: 'reference',
								},
							},
						],
					},
				],
			}),
		)
		expect(markdown).toContain('[marks ')
		expect(markdown).not.toContain(':::tiptap')
		expect(markdown).not.toContain('<')
	})

	it('rejects misplaced reserved blocks and invalid native attributes without erasing them', () => {
		expect(parse(`Before\n${rawBlock(paragraph('After'))}`)).toMatchObject({ ok: false })
		const literal = 'Before\n:::attrs {}\nAfter'
		expect(parseTypstMarkdown({ ...options, format: 'markdown', markdown: literal })).toMatchObject(
			{ ok: true },
		)
		roundTrip(document(paragraph(literal)))
		expect(parse(':::attrs {"unknown":true}\nText\n:::')).toMatchObject({ ok: false })
		expect(parse(':::attrs {}\nOne\n\nTwo\n:::')).toMatchObject({ ok: false })
		expect(parse('[marks [{"type":"unknown"}]]Text[/marks]')).toMatchObject({ ok: false })
	})

	it('keeps heading level editable in Markdown when alignment needs native attributes', () => {
		const heading: JSONContent = {
			type: 'heading',
			attrs: { level: 2, textAlign: 'center' },
			content: [{ type: 'text', text: 'Heading' }],
		}
		const markdown = roundTrip(document(heading))
		expect(markdown).not.toContain('"level"')
		expect(parsedDocument(markdown.replace('## Heading', '### Heading')).content![0]).toMatchObject(
			{ type: 'heading', attrs: { level: 3, textAlign: 'center' } },
		)
	})

	it('keeps raw unknown attributes visible to validation instead of normalizing them away', () => {
		expect(parse(rawBlock({ ...paragraph('Text'), mark: 'bold' }))).toMatchObject({ ok: false })
		for (const node of [
			{ ...paragraph('Text'), attrs: { agentOnly: true } },
			{
				type: 'paragraph',
				content: [
					{
						type: 'text',
						text: 'Text',
						marks: [{ type: 'textStyle', attrs: { lineHeight: '2' } }],
					},
				],
			},
			{ ...component, attrs: { ...component.attrs, secret: 'must not disappear' } },
		])
			expect(parse(rawBlock(node))).toMatchObject({
				ok: false,
				issues: expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_ATTRIBUTE' })]),
			})
	})

	it('does not use native JSON to bypass block structure, geometry or region rules', () => {
		for (const value of [
			{ type: 'text', text: 'Inline root' },
			{ type: 'dataField', attrs: { path: ['customer', 'name'] } },
			{ type: 'table', content: [] },
			{ type: 'unknownNode' },
			{ type: 'doc', content: [component, component] },
		])
			expect(parse(rawBlock(value))).toMatchObject({ ok: false })
		expect(
			parseTypstMarkdown({
				...options,
				config: { ...config, regions: [{ id: 'body', nodes: ['paragraph', 'text'] }] },
				markdown: rawBlock(table),
			}),
		).toMatchObject({
			ok: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: 'REGION_RULE' })]),
		})
	})
})

describe('agent Markdown syntax admission', () => {
	it('preserves literal annotations through export, Markdown escapes and code spans', () => {
		const literal = '[textStyle {"color":"#f00"}]literal[/textStyle]'
		roundTrip(document(paragraph(literal)))
		roundTrip(document(paragraph('[dataField {"path":["customer","name"]}]')))
		const escaped = parsedDocument('\\[textStyle {"color":"#f00"}]literal\\[/textStyle]')
		expect(native(escaped)).toEqual(native(document(paragraph(literal))))
		const code = parsedDocument(`\`${literal}\``)
		expect(code.content![0]!.content).toEqual([
			{ type: 'text', text: literal, marks: [{ type: 'code' }] },
		])
		roundTrip(code)
	})

	it('does not parse malformed annotations or JSON blocks inside code fences', () => {
		const literal = '[textStyle not-json]\n[dataField {}]\n:::tiptap\nnot-json\n:::'
		const imported = parsedDocument(`\`\`\`text\n${literal}\n\`\`\``)
		expect(imported.content).toEqual([
			{
				type: 'codeBlock',
				attrs: { language: 'text' },
				content: [{ type: 'text', text: literal }],
			},
		])
		roundTrip(imported)
		const ordinaryTypst = parsedDocument('```typst\n#text[Example]\n```')
		expect(ordinaryTypst.content![0]!.type).toBe('codeBlock')
	})

	it('rejects incomplete or invalid reserved syntax without treating it as ordinary text', () => {
		for (const markdown of [
			'[textStyle {"color":"#f00"}]unclosed',
			'orphan[/textStyle]',
			'[textStyle not-json]Text[/textStyle]',
			'[textStyle {"color":"red"}]Text[/textStyle]',
			'[textStyle {"color":"red"}][/textStyle]',
			'[textStyle {"color":"#f00","color":"#000"}]Text[/textStyle]',
			'[textStyle',
			'[textStyle {"lineHeight":"2"}]Text[/textStyle]',
			'[textStyle {"color":"#f00"}][textStyle {"color":"#000"}]Text[/textStyle][/textStyle]',
			'[dataField {"path":["customer","name"]}',
			'[dataField {"path":["customer","name"],"extra":true}]',
			'[dataField {"path":["missing"]}]',
			':::tiptap\n{"type":"paragraph"}',
			':::tiptap\nnot-json\n:::',
			':::tiptap\nnull\n:::',
			':::tiptap\n{"type":"doc","content":[]}\n:::',
		]) {
			const result = parse(markdown)
			expect(result).toMatchObject({
				ok: false,
				issues: expect.arrayContaining([expect.objectContaining({ code: expect.any(String) })]),
			})
		}
	})

	it('keeps default Markdown behavior and its existing loss reporting unchanged', () => {
		const plainOptions = { config, regionId: 'body', data }
		expect(
			exportTypstMarkdown({ ...plainOptions, document: styled({ color: '#f00' }) }),
		).toMatchObject({
			ok: true,
			value: { lossless: false },
		})
		const literal = '[textStyle {"color":"#f00"}]Text[/textStyle]'
		const plain = parseTypstMarkdown({ ...plainOptions, markdown: literal })
		if (!plain.ok) throw new Error(JSON.stringify(plain.issues))
		expect(native(plain.value)).toEqual(native(document(paragraph(literal))))
		const ordinary = parseTypstMarkdown({ ...plainOptions, markdown: '**Bold** and *italic*' })
		if (!ordinary.ok) throw new Error(JSON.stringify(ordinary.issues))
		expect(native(parsedDocument('**Bold** and *italic*'))).toEqual(native(ordinary.value))
		expect(
			parseTypstMarkdown({ ...plainOptions, markdown: '<span style="color:#f00">Text</span>' }),
		).toMatchObject({
			ok: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: 'UNSUPPORTED_MARKDOWN' })]),
		})
	})
})

describe('agent Markdown candidate transaction', () => {
	it('replaces a styled target, preserves adjacent complex nodes and supports one undo', () => {
		const original = document(styled({ color: '#f00' }).content![0]!, table, component)
		let state = EditorState.create({
			schema,
			doc: schema.nodeFromJSON(original),
			plugins: [history()],
		})
		let dispatches = 0
		const dispatch = (transaction: Parameters<typeof state.apply>[0]) => {
			state = state.apply(transaction)
			dispatches++
		}
		const editor = {
			schema,
			get state() {
				return state
			},
			getJSON: () => state.doc.toJSON(),
			view: { dispatch },
		} as unknown as Editor
		const baseline = editor.getJSON()
		const candidate = prepareTypstCandidate({
			candidate: {
				regionId: 'body',
				baseRevision: 7,
				format: 'agent',
				range: { from: 0, to: state.doc.child(0).nodeSize },
				markdown: '[textStyle {"color":"#f00"}]**更新内容**[/textStyle]',
			},
			currentRevision: 7,
			document: original,
			config,
			data,
			canEdit: () => true,
		})
		if (!candidate.ok) throw new Error(JSON.stringify(candidate.issues))
		expect(dispatches).toBe(0)
		expect(
			applyTypstCandidate({
				candidate: candidate.value,
				editor,
				regionId: 'body',
				currentRevision: () => 7,
				config,
				data: () => data,
				canEdit: () => true,
			}),
		).toEqual({ ok: true, value: undefined })
		expect(dispatches).toBe(1)
		expect(state.doc.child(0).textContent).toBe('更新内容')
		expect(editor.getJSON().content!.slice(1)).toEqual(baseline.content!.slice(1))
		expect(editor.getJSON().content![0]!.content![0]!.marks).toEqual(
			expect.arrayContaining([
				{ type: 'bold' },
				expect.objectContaining({
					type: 'textStyle',
					attrs: expect.objectContaining({ color: '#f00' }),
				}),
			]),
		)
		expect(undo(state, dispatch)).toBe(true)
		expect(editor.getJSON()).toEqual(baseline)
	})
})

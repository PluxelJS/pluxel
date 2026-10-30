import { describe, expect, it } from 'vitest'
import { parse, parseAst } from '@r4ai/typst-ast-node'
import { CellSelection } from '@tiptap/pm/tables'
import type { JSONContent } from '@tiptap/core'
import { typstSourceLibrary } from '../src/source/library.js'
import { parseTypstSource } from '../src/source/parse.js'
import { projectTypstSource } from '../src/source/project.js'
import { prepareTypstSourceEdit } from '../src/source/writeback.js'
import { createTypstSourceProject } from '../src/source/node.js'
import { createTypstSourceEditor, prepareTypstSourceCopy } from '../src/tiptap/source-editor.js'
import { prepareLink } from '../src/tiptap/link-actions.js'

const parser = { parse, parseAst }
const project = (source: string) =>
	projectTypstSource({ path: 'sections/analysis.typ', revision: 1, source, parser })
const all = (doc: JSONContent): JSONContent[] => [doc, ...(doc.content?.flatMap(all) ?? [])]
function edit(source: string, change: (doc: JSONContent) => void): string {
	const projection = project(source),
		doc = structuredClone(projection.document)
	change(doc)
	const result = prepareTypstSourceEdit(projection, doc)
	if (!result.ok) throw new Error(JSON.stringify(result.issues))
	let bytes = Buffer.from(source)
	for (const patch of result.value.toReversed())
		bytes = Buffer.concat([
			bytes.subarray(0, patch.from),
			Buffer.from(patch.text),
			bytes.subarray(patch.to),
		])
	return bytes.toString()
}

describe('source projection and localized edits', () => {
	it('edits an explicitly opened text path without an extension and validates its new syntax', () => {
		const state = createTypstSourceProject({ files: { body: 'Hello' } })
		const projection = state.open('body'),
			document = structuredClone(projection.document)
		all(document).find((node) => node.type === 'text')!.text = 'Edited'
		expect(state.edit({ projection, document }).ok).toBe(true)
		expect(state.open('body').source).toBe('Edited')
		const current = state.open('body'),
			invalid = structuredClone(current.document)
		invalid.content!.push({ type: 'typstSource', attrs: { role: 'unknown', source: '#text[' } })
		expect(state.edit({ projection: current, document: invalid })).toMatchObject({
			ok: false,
			issues: [{ code: 'SYNTAX_ERROR', path: 'body' }],
		})
		expect(state.revision).toBe(1)
		expect(state.open('body').source).toBe('Edited')
	})
	it('retains emptied paragraphs and untouched formatting calls in authored source', () => {
		for (const source of [
			'Hello\n\nWorld',
			'#text(fill: red, weight: if true { "bold" } else { "regular" })[*Hello*]\n\nWorld',
		]) {
			const changed = edit(source, (document) => {
				document.content![0]!.content = []
			})
			expect(changed).toContain('#par[')
			expect(project(changed).document.content).toHaveLength(2)
			expect(project(changed).document.content![0]!.content ?? []).toEqual([])
			expect(project(changed).document.content![1]!.content?.[0]?.text).toBe('World')
			expect(changed.includes('weight: if true { "bold" } else { "regular" }')).toBe(
				source.startsWith('#text'),
			)
		}
	})
	it('keeps CST bytes and distinct UTF-8 / UTF-16 positions', () => {
		const source = '// 注释\r\n中文😀e\u0301 #text(fill: red)[*文字*]\r\n'
		const parsed = parseTypstSource(source, parser)
		expect(parsed.cst.range[1]).toBe(Buffer.byteLength(source))
		expect(parsed.byteToUtf16.get(Buffer.byteLength(source))).toBe(source.length)
		expect(() => parseTypstSource('a\uD800b', parser)).toThrow('surrogate')
	})
	it('opens and saves without changing comments, unknown syntax, CRLF or escapes', () => {
		const source = '// 注释\r\n= 标题\r\n\r\n普通\\*文字😀 #foo(x: 2)[未知] 结尾\r\n'
		const p = project(source)
		expect(prepareTypstSourceEdit(p, structuredClone(p.document))).toEqual({ ok: true, value: [] })
		expect(all(p.document).filter((node) => node.type === 'typstInlineSource')).toHaveLength(1)
		expect(all(p.document).find((node) => node.type === 'typstInlineSource')?.attrs?.source).toBe(
			'#foo(x: 2)[未知]',
		)
	})
	it('preserves an outer call, computed parameters and strong delimiters while editing text', () => {
		const source = '#text(fill:red, weight: if true {"bold"} else {"regular"})[*重要事项*]'
		const changed = edit(source, (doc) => {
			all(doc).find((node) => node.text === '重要事项')!.text = '重要更新😀'
		})
		expect(changed).toBe(source.replace('重要事项', '重要更新😀'))
		expect(parse(changed).errors).toEqual([])
	})
	it('removes strong delimiters while preserving the text call and its unknown parameters', () => {
		const source = '#text(fill:red, weight: if true {"bold"} else {"regular"})[*重要事项*]'
		const changed = edit(source, (doc) => {
			const node = all(doc).find((candidate) => candidate.text === '重要事项')!
			node.marks = node.marks!.filter((mark) => mark.type !== 'bold')
		})
		expect(changed).toBe(source.replace('*重要事项*', '重要事项'))
		expect(parse(changed).errors).toEqual([])
	})
	it('does not erase comments when two text spans merge in ProseMirror', () => {
		const source = '前文/* keep */后文'
		expect(
			edit(source, (doc) => {
				all(doc).find((node) => node.type === 'text')!.text = '前文后续'
			}),
		).toBe('前文/* keep */后续')
		const p = project(source),
			doc = structuredClone(p.document)
		all(doc).find((node) => node.type === 'text')!.text = '替换'
		expect(prepareTypstSourceEdit(p, doc).ok).toBe(false)
	})
	it('retains and edits inline reference and field marks across source reprojection', () => {
		const source =
			'#import "lib/pluxel.typ" as report\n\n*#report.field(json("data.json"), ("name",))* and *#report.reference(<fig:x>)*'
		const state = createTypstSourceProject({
			files: {
				'body.typ': source,
				'lib/pluxel.typ': typstSourceLibrary,
				'data.json': '{"name":"Ada"}',
			},
		})
		const initial = state.open('body.typ')
		for (const type of ['typstField', 'reference'])
			expect(all(initial.document).find((node) => node.type === type)?.marks).toEqual([
				{ type: 'bold' },
			])
		const doc = structuredClone(initial.document)
		all(doc).find((node) => node.type === 'typstField')!.marks = [{ type: 'italic' }]
		all(doc).find((node) => node.type === 'reference')!.marks = []
		const result = state.edit({ projection: initial, document: doc })
		if (!result.ok) throw new Error(JSON.stringify(result.issues))
		const changed = state.open('body.typ')
		expect(changed.source).toBe(
			source
				.replace(
					'*#report.field(json("data.json"), ("name",))*',
					'_#report.field(json("data.json"), ("name",))_',
				)
				.replace('*#report.reference(<fig:x>)*', '#report.reference(<fig:x>)'),
		)
		expect(all(changed.document).find((node) => node.type === 'typstField')?.marks).toEqual([
			{ type: 'italic' },
		])
		expect(all(changed.document).find((node) => node.type === 'reference')?.marks ?? []).toEqual([])
	})
	it('applies code to decoded text and dynamic fields without rendering their authored markup as text', () => {
		const source = 'A\\#B\\u{20}\\u{20}😀'
		const state = createTypstSourceProject({ files: { 'body.typ': source } }),
			editor = createTypstSourceEditor({ project: state, path: 'body.typ' })
		try {
			expect(editor.chain().setTextSelection({ from: 1, to: 9 }).setCode().run()).toBe(true)
			expect(state.open('body.typ').source).toBe('#raw("A#B  😀")')
			expect(
				all(state.open('body.typ').document).find((node) => node.type === 'text'),
			).toMatchObject({ text: 'A#B  😀', marks: [{ type: 'code' }] })
			expect(editor.commands.unsetCode()).toBe(true)
			expect(all(state.open('body.typ').document).find((node) => node.type === 'text')?.text).toBe(
				'A#B  😀',
			)
		} finally {
			editor.destroy()
		}
		const call = '#report.field(json("data.json"), ("name",))',
			fieldSource = '#import "lib/pluxel.typ" as report\n\n' + call
		const fields = createTypstSourceProject({
			files: {
				'body.typ': fieldSource,
				'lib/pluxel.typ': typstSourceLibrary,
				'data.json': '{"name":"Ada"}',
			},
		})
		const initial = fields.open('body.typ'),
			document = structuredClone(initial.document)
		all(document).find((node) => node.type === 'typstField')!.marks = [{ type: 'code' }]
		expect(fields.edit({ projection: initial, document }).ok).toBe(true)
		const coded = fields.open('body.typ')
		expect(coded.source).toBe(
			fieldSource.replace(call, '#raw(report.field(json("data.json"), ("name",)))'),
		)
		expect(all(coded.document).find((node) => node.type === 'typstField')).toMatchObject({
			attrs: { source: call },
			marks: [{ type: 'code' }],
		})
		const plain = structuredClone(coded.document)
		all(plain).find((node) => node.type === 'typstField')!.marks = []
		expect(fields.edit({ projection: coded, document: plain }).ok).toBe(true)
		expect(fields.open('body.typ').source).toBe(fieldSource)
	})
	it('rejects bindings that lose their declared meaning after insertion into a shadowed scope', () => {
		const files = {
			'body.typ': '#import "lib/pluxel.typ" as report\n#let json(path) = (name: "fake")\n\nText',
			'lib/pluxel.typ': typstSourceLibrary,
			'data.json': '{"name":"Ada"}',
		}
		const state = createTypstSourceProject({ files }),
			projection = state.open('body.typ'),
			document = structuredClone(projection.document)
		document.content!.at(-1)!.content!.push({
			type: 'typstField',
			attrs: {
				file: 'data.json',
				path: ['name'],
				source: '#report.field(json("data.json"), ("name",))',
			},
		})
		const result = state.edit({ projection, document })
		expect(result).toMatchObject({
			ok: false,
			issues: [{ code: 'UNSUPPORTED_EDIT', message: expect.stringContaining('binding') }],
		})
		expect(state.revision).toBe(0)
		expect(state.open('body.typ').source).toBe(files['body.typ'])
		const components = createTypstSourceProject({
			files: {
				'body.typ':
					'#import "template.typ" as blocks\n#let blocks = (chart: (title: "") => [Other])\n\nText',
				'template.typ': '#let chart(title: "") = [#title]',
			},
			components: [
				{
					module: 'template.typ',
					name: 'chart',
					label: 'Chart',
					parameters: { title: { type: 'string' } },
				},
			],
		})
		const old = components.open('body.typ'),
			next = structuredClone(old.document)
		next.content!.push({
			type: 'typstComponent',
			attrs: {
				module: 'template.typ',
				name: 'chart',
				label: 'Chart',
				parameters: { title: { type: 'string' } },
				props: { title: 'Wanted' },
				binding: null,
				source: '#blocks.chart(title: "Wanted")',
			},
		})
		expect(components.edit({ projection: old, document: next })).toMatchObject({
			ok: false,
			issues: [{ code: 'UNSUPPORTED_EDIT', message: expect.stringContaining('binding') }],
		})
		expect(components.revision).toBe(0)
	})
	it('allows an explicit source-card edit to expose an additional verified binding', () => {
		const state = createTypstSourceProject({
			files: {
				'body.typ': '#import "lib/pluxel.typ" as report\n\n#unknown()',
				'lib/pluxel.typ': typstSourceLibrary,
				'data.json': '{"name":"Ada"}',
			},
		})
		const projection = state.open('body.typ'),
			document = structuredClone(projection.document)
		document.content!.at(-1)!.attrs!.source = '#report.field(json("data.json"), ("name",))'
		expect(state.edit({ projection, document }).ok).toBe(true)
		expect(all(state.open('body.typ').document).some((node) => node.type === 'typstField')).toBe(
			true,
		)
	})
	it('projects captions and associates a label across comments without including neighboring text', () => {
		const source =
			'#figure(image("../assets/a.svg"), caption: [营收 *增长*]) /* keep */ <fig:revenue>\n\n引用 @fig:revenue。'
		const p = project(source)
		expect(p.labels[0]?.target?.to).toBe(Buffer.byteLength(source.split('\n')[0]!))
		expect(all(p.document).find((node) => node.type === 'figure')?.attrs).toEqual({
			id: 'fig:revenue',
			label: 'fig:revenue',
		})
		expect(p.references[0]?.label).toBe('fig:revenue')
		expect(
			edit(source, (doc) => {
				all(doc).find((node) => node.text === '增长')!.text = '持续增长'
			}),
		).toBe(source.replace('增长', '持续增长'))
	})
	it('projects merged table cells and edits only the second paragraph', () => {
		const source =
			'#table(columns: (1fr, 2fr), inset: 3pt, table.header([名称], [金额]), table.cell(colspan: 2)[一段\n\n二段], [A], [42])'
		const p = project(source)
		expect(
			all(p.document)
				.filter((node) => node.type === 'tableCell')
				.some((node) => node.attrs?.colspan === 2 && node.content?.length === 2),
		).toBe(true)
		expect(
			edit(source, (doc) => {
				all(doc).find((node) => node.text === '二段')!.text = '新的二段'
			}),
		).toBe(source.replace('二段', '新的二段'))
	})
	it('edits image dimensions and alternative text without losing native image parameters', () => {
		const source = '#image("asset.svg", width: 75pt, height: 30pt, alt: "Old", fit: "contain")'
		const state = createTypstSourceProject({ files: { 'body.typ': source } })
		const issues: unknown[] = [],
			editor = createTypstSourceEditor({
				project: state,
				path: 'body.typ',
				onIssues: (value) => issues.push(...value),
			})
		try {
			expect(all(editor.getJSON()).find((node) => node.type === 'image')?.attrs).toMatchObject({
				width: 100,
				height: 40,
				alt: 'Old',
			})
			expect(editor.commands.setNodeSelection(0)).toBe(true)
			expect(
				editor.commands.updateAttributes('image', { width: 120, height: null, alt: 'A "chart"' }),
			).toBe(true)
			expect(issues).toEqual([])
			expect(state.open('body.typ').source).toBe(
				'#image("asset.svg", width: 90pt,  alt: "A \\"chart\\"", fit: "contain")',
			)
			expect(
				all(state.open('body.typ').document).find((node) => node.type === 'image')?.attrs,
			).toMatchObject({ width: 120, height: null, alt: 'A "chart"' })
		} finally {
			editor.destroy()
		}
		const inserted = edit('Paragraph', (doc) => {
			doc.content!.push({
				type: 'image',
				attrs: { src: 'asset.svg', width: 80, height: 40, alt: 'Inserted' },
			})
		})
		expect(inserted).toContain('#image("asset.svg", width: 60pt, height: 30pt, alt: "Inserted")')
	})
	it('edits ordered list numbering and native list children while preserving named parameters', () => {
		const source = '#enum(start: 3, numbering: "a.", tight: false, [First], [Second])'
		const state = createTypstSourceProject({ files: { 'body.typ': source } })
		const issues: unknown[] = [],
			editor = createTypstSourceEditor({
				project: state,
				path: 'body.typ',
				onIssues: (value) => issues.push(...value),
			})
		try {
			expect(editor.getJSON().content?.[0]?.attrs).toMatchObject({ start: 3, type: 'a' })
			expect(editor.commands.setTextSelection(3)).toBe(true)
			expect(editor.commands.updateAttributes('orderedList', { start: 4, type: 'I' })).toBe(true)
			expect(state.open('body.typ').source).toBe(
				source.replace('start: 3', 'start: 4').replace('"a."', '"I."'),
			)
			expect(editor.commands.insertContent({ type: 'text', text: 'New ' })).toBe(true)
			expect(state.open('body.typ').source).toContain('[New First]')
			expect(editor.commands.updateAttributes('orderedList', { type: null })).toBe(true)
			expect(state.open('body.typ').source).toContain('tight: false')
			expect(issues).toEqual([])
		} finally {
			editor.destroy()
		}
		const numbered = edit('+ First\n+ Second', (doc) => {
			doc.content![0]!.attrs = { start: 2, type: 'A' }
		})
		expect(
			all(project(numbered).document).find((node) => node.type === 'orderedList')?.attrs,
		).toMatchObject({ start: 2, type: 'A' })
	})
	it('writes table cell alignment while preserving native cell fill and rich content', () => {
		const source = '#table(columns: 1, table.cell(align: right, fill: yellow)[A\n\n*B*])'
		const changed = edit(source, (doc) => {
			all(doc).find((node) => node.type === 'tableCell')!.attrs!.align = 'center'
		})
		expect(changed).toContain('align: center')
		expect(changed).toContain('fill: yellow')
		expect(changed).toContain('[A\n\n*B*]')
		expect(
			all(project(changed).document).find((node) => node.type === 'tableCell')?.attrs?.align,
		).toBe('center')
		const reset = edit(changed, (doc) => {
			all(doc).find((node) => node.type === 'tableCell')!.attrs!.align = null
		})
		expect(reset).not.toContain('align:')
		const state = createTypstSourceProject({ files: { 'body.typ': source } }),
			editor = createTypstSourceEditor({ project: state, path: 'body.typ' })
		try {
			expect(all(editor.getJSON()).find((node) => node.type === 'tableCell')?.attrs?.align).toBe(
				'right',
			)
		} finally {
			editor.destroy()
		}
	})
	it('treats shadowed and wildcard-imported builtin names as source', () => {
		for (const source of [
			'#let text(x) = x\n#text[自定义]',
			'#import "x.typ": *\n#figure([未知])',
		]) {
			const p = project(source)
			expect(all(p.document).filter((node) => node.type === 'typstSource')).toHaveLength(2)
		}
	})
	it('does not index labels/references manufactured by closures or loops', () => {
		const p = project(
			'#for x in range(3) { [#figure([x]) <fig:generated>] }\n#context [@fig:generated]\n@book',
		)
		expect(p.labels).toEqual([])
		expect(p.references.map((ref) => ref.label)).toEqual(['book'])
	})
	it('keeps invalid source and byte diagnostics repairable', () => {
		const source = '中文 #text[未闭合'
		const p = project(source)
		expect(p.editable).toBe(false)
		expect(all(p.document).find((node) => node.attrs?.role === 'invalid')?.attrs?.source).toBe(
			'#text[未闭合',
		)
		expect(p.diagnostics[0]?.code).toBe('SYNTAX_ERROR')
		expect(
			edit(source, (doc) => {
				all(doc).find((node) => node.attrs?.role === 'invalid')!.attrs!.source += ']'
			}),
		).toBe(source + ']')
	})

	it('keeps a comment immediately before the replaced character', () => {
		expect(
			edit('前/*keep*/后', (doc) => {
				all(doc).find((node) => node.type === 'text')!.text = '前新'
			}),
		).toBe('前/*keep*/新')
	})
	it('edits inline code without interpreting markup and reopens the same code mark', () => {
		const changed = edit('前 `a#b` 后', (doc) => {
			all(doc).find((node) => node.text === 'a#b')!.text = '新*代码`'
		})
		expect(parse(changed).errors).toEqual([])
		expect(all(project(changed).document).find((node) => node.text === '新*代码`')?.marks).toEqual([
			{ type: 'code' },
		])
	})
	it('preserves quote call parameters while editing its paragraphs', () => {
		const source = '#quote(block: true, attribution: [作者])[一段\n\n二段]'
		expect(
			edit(source, (doc) => {
				all(doc).find((node) => node.text === '二段')!.text = '修改'
			}),
		).toBe(source.replace('二段', '修改'))
	})
	it('uses native table row insertion and preserves authored table parameters', () => {
		const source =
			'#table(columns: (1fr, 2fr), inset: 3pt, fill: (x, y) => if y == 0 { gray } else { white }, [A], [B])'
		const state = createTypstSourceProject({ files: { 'main.typ': source } })
		const issues: unknown[] = []
		const editor = createTypstSourceEditor({
			project: state,
			path: 'main.typ',
			onIssues: (value) => issues.push(...value),
		})
		try {
			editor.commands.setTextSelection(4)
			expect(editor.commands.addRowAfter()).toBe(true)
			const next = state.snapshot().files['main.typ'] as string
			expect(next).toContain('inset: 3pt')
			expect(next).toContain('fill: (x, y) => if y == 0 { gray } else { white }')
			expect(parse(next).errors).toEqual([])
			expect(
				all(state.open('main.typ').document).filter((node) => node.type === 'tableRow'),
			).toHaveLength(2)
			expect(issues).toEqual([])
		} finally {
			editor.destroy()
		}
	})
	it('uses native list indentation with valid nested Typst output', () => {
		const state = createTypstSourceProject({ files: { 'main.typ': '- 一\n- 二' } })
		const issues: unknown[] = []
		const editor = createTypstSourceEditor({
			project: state,
			path: 'main.typ',
			onIssues: (value) => issues.push(...value),
		})
		try {
			editor.commands.setTextSelection(8)
			expect(editor.commands.sinkListItem('listItem')).toBe(true)
			const source = state.snapshot().files['main.typ'] as string
			expect(parse(source).errors).toEqual([])
			expect(
				all(state.open('main.typ').document).filter((node) => node.type === 'bulletList'),
			).toHaveLength(2)
			expect(issues).toEqual([])
		} finally {
			editor.destroy()
		}
	})

	it('changes a partial bold selection without leaving old delimiters in the text', () => {
		for (const [source, action, expected] of [
			['*hello*', 'unsetBold', '*h*ell*o*'],
			[
				'#text(fill:red,weight:if true {"bold"} else {"regular"})[hello]',
				'toggleBold',
				'#text(fill:red,weight:if true {"bold"} else {"regular"})[h*ell*o]',
			],
		] as const) {
			const state = createTypstSourceProject({ files: { 'main.typ': source } })
			const issues: unknown[] = []
			const editor = createTypstSourceEditor({
				project: state,
				path: 'main.typ',
				onIssues: (value) => issues.push(...value),
			})
			try {
				editor.commands.setTextSelection({ from: 2, to: 5 })
				expect(editor.commands[action]()).toBe(true)
				expect(state.snapshot().files['main.typ']).toBe(expected)
				expect(issues).toEqual([])
			} finally {
				editor.destroy()
			}
		}
	})

	it('recognizes library calls only through an unshadowed verified import', () => {
		const source =
			'#import "../lib/pluxel.typ" as report\n#report.latex("x^2", block: true) <eq:x>\n\n#report.reference(<eq:x>, caption: false)'
		for (const library of [typstSourceLibrary, new TextEncoder().encode(typstSourceLibrary)]) {
			const p = projectTypstSource({
				path: 'sections/math.typ',
				revision: 1,
				source,
				parser,
				files: { 'lib/pluxel.typ': library },
			})
			expect(all(p.document).find((node) => node.type === 'blockMath')?.attrs?.latex).toBe('x^2')
			expect(all(p.document).find((node) => node.type === 'reference')?.attrs?.showCaption).toBe(
				false,
			)
			expect(p.labels.map((node) => node.label)).toEqual(['eq:x'])
			expect(p.references).toMatchObject([{ label: 'eq:x', syntax: 'label' }])
		}
		const unknown = project(source)
		expect(all(unknown.document).some((node) => node.type === 'blockMath')).toBe(false)
	})
	it('keeps reference caption false distinct from auto and edits LaTeX as a string', () => {
		const source =
			'#import "lib/pluxel.typ" as report\n#report.latex("x^2", block: true) <eq:x>\n\n#report.reference(<eq:x>, caption: false)'
		const state = createTypstSourceProject({
			files: { 'main.typ': source, 'lib/pluxel.typ': typstSourceLibrary },
		})
		const doc = structuredClone(state.open('main.typ').document)
		all(doc).find((node) => node.type === 'reference')!.attrs!.showCaption = null
		all(doc).find((node) => node.type === 'blockMath')!.attrs!.latex = '\\frac{1}{2}'
		expect(state.edit({ projection: state.open('main.typ'), document: doc }).ok).toBe(true)
		const updated = state.snapshot().files['main.typ'] as string
		expect(updated).toContain('caption: auto')
		expect(updated).toContain('"\\\\frac{1}{2}"')
		expect(parse(updated).errors).toEqual([])
	})
	it('derives component controls from declared literal props and keeps JSON a separate binding', () => {
		const source =
			'#import "../template/blocks.typ": notice\n#notice(title: "旧", loud: false, tone: if true { red } else { blue }, data: json("../data/sales.json"))[内容]'
		const components = [
			{
				module: 'template/blocks.typ',
				name: 'notice',
				label: '提示',
				parameters: {
					title: { type: 'string' as const },
					loud: { type: 'boolean' as const },
					count: { type: 'number' as const },
				},
				data: 'data',
			},
		]
		const state = createTypstSourceProject({
			files: {
				'sections/a.typ': source,
				'template/blocks.typ': '#let notice(..args) = []',
				'data/sales.json': '{"value":42}',
			},
			components,
		})
		const p = state.open('sections/a.typ'),
			doc = structuredClone(p.document)
		const component = all(doc).find((node) => node.type === 'typstComponent')!
		expect(component.attrs?.binding).toEqual({
			file: 'data/sales.json',
			source: '../data/sales.json',
		})
		expect(component.attrs?.props).toEqual({ title: '旧', loud: false })
		component.attrs!.props = { title: '新', loud: true, count: 3 }
		expect(state.edit({ projection: p, document: doc }).ok).toBe(true)
		const next = state.snapshot().files['sections/a.typ'] as string
		expect(next).toContain('tone: if true { red } else { blue }')
		expect(next).toContain('count: 3)[内容]')
		expect(parse(next).errors).toEqual([])
		expect(state.snapshot().files['data/sales.json']).toBe('{"value":42}')
	})
	it('does not call code label literals declarations and exposes explicit field bindings', () => {
		const source =
			'#import "lib/pluxel.typ" as report\n#let target = <not-a-declaration>\n\n#report.field(json("data/a.json"), ("company",))'
		const p = projectTypstSource({
			path: 'main.typ',
			revision: 1,
			source,
			parser,
			files: { 'lib/pluxel.typ': typstSourceLibrary },
		})
		expect(p.labels).toEqual([])
		expect(all(p.document).find((node) => node.type === 'typstField')?.attrs).toMatchObject({
			file: 'data/a.json',
			path: ['company'],
		})
	})

	it('limits malformed syntax to its CST boundary and leaves the following paragraph editable', () => {
		const source = '= Good\n\n#let x =\n\nLater text'
		const p = project(source)
		expect(all(p.document).find((node) => node.attrs?.role === 'invalid')?.attrs?.source).toBe(
			'#let x =',
		)
		expect(
			edit(source, (doc) => {
				all(doc).find((node) => node.text === 'Later text')!.text = 'Later edit'
			}),
		).toBe(source.replace('Later text', 'Later edit'))
	})

	it('round trips four table appearances as editable native table source', () => {
		const state = createTypstSourceProject({
			files: { 'main.typ': '#table(columns: 2, inset: 4pt, table.header([A], [B]), [甲], [乙])' },
		})
		const issues: unknown[] = [],
			editor = createTypstSourceEditor({
				project: state,
				path: 'main.typ',
				onIssues: (value) => issues.push(...value),
			})
		try {
			for (const tableStyle of ['three-line', 'grid-open-sides', 'grid', 'borderless', null]) {
				editor.commands.setTextSelection(4)
				expect(editor.commands.updateAttributes('table', { tableStyle })).toBe(true)
				const source = state.snapshot().files['main.typ'] as string
				expect(source).toContain('inset: 4pt')
				expect(parse(source).errors).toEqual([])
				expect(
					all(state.open('main.typ').document).find((node) => node.type === 'table')?.attrs
						?.tableStyle,
				).toBe(tableStyle)
			}
			expect(issues).toEqual([])
		} finally {
			editor.destroy()
		}
	})
	it('merges and splits cells through the real TableKit commands', () => {
		const state = createTypstSourceProject({
			files: { 'main.typ': '#table(columns: 2, [A], [B], [C], [D])' },
		})
		const issues: unknown[] = [],
			editor = createTypstSourceEditor({
				project: state,
				path: 'main.typ',
				onIssues: (value) => issues.push(...value),
			})
		try {
			editor.view.dispatch(
				editor.state.tr.setSelection(CellSelection.create(editor.state.doc, 2, 7)),
			)
			expect(editor.commands.mergeCells()).toBe(true)
			expect(
				all(state.open('main.typ').document).some(
					(node) =>
						node.type === 'tableCell' && node.attrs?.colspan === 2 && node.content?.length === 2,
				),
			).toBe(true)
			editor.commands.setTextSelection(4)
			expect(editor.commands.splitCell()).toBe(true)
			expect(
				all(state.open('main.typ').document).filter((node) => node.type === 'tableCell'),
			).toHaveLength(4)
			expect(issues).toEqual([])
		} finally {
			editor.destroy()
		}
	})
	it('preserves untouched relative column sizing while resizing one column', () => {
		const source = '#table(columns: (1fr, 2fr), [A], [B])'
		const changed = edit(source, (doc) => {
			all(doc).find((node) => node.type === 'tableCell')!.attrs!.colwidth = [120]
		})
		expect(changed).toContain('columns: (90pt, 2fr,)')
		expect(
			all(project(changed).document).find((node) => node.type === 'tableCell')?.attrs?.colwidth,
		).toEqual([120])
	})
	it('keeps repeated cell content attached to its own source parameters during table edits', () => {
		const source =
			'#table(columns: (1fr, 2fr), table.cell(fill: red, inset: 2pt)[A], table.cell(fill: blue, inset: 8pt)[A], [B], [C])'
		const state = createTypstSourceProject({ files: { 'main.typ': source } })
		const issues: unknown[] = []
		const editor = createTypstSourceEditor({
			project: state,
			path: 'main.typ',
			onIssues: (value) => issues.push(...value),
		})
		try {
			editor.commands.setTextSelection(4)
			editor.commands.addRowAfter()
			editor.commands.updateAttributes('table', { tableStyle: 'borderless' })
			editor.commands.updateAttributes('tableCell', { align: 'right', colwidth: [120] })
			const changed = state.snapshot().files['main.typ'] as string
			expect(changed).toContain('columns: (90pt, 2fr,)')
			expect(changed).toMatch(/fill: red, inset: 2pt[^\]]*align: right[^\]]*\[A\]/)
			expect(changed).toMatch(/fill: blue, inset: 8pt[^\]]*\[A\]/)
			expect(changed.match(/fill: red/g)).toHaveLength(1)
			expect(changed.match(/fill: blue/g)).toHaveLength(1)
			expect(
				all(state.open('main.typ').document).filter((node) => node.type === 'tableRow'),
			).toHaveLength(3)
			expect(issues).toEqual([])
		} finally {
			editor.destroy()
		}
	})
	it('edits and removes an entire rich link from a caret without losing its inner source', () => {
		const source = '#link("https://old.example")[Hello /* keep */*world*]'
		const state = createTypstSourceProject({ files: { 'main.typ': source } })
		const issues: unknown[] = []
		const editor = createTypstSourceEditor({
			project: state,
			path: 'main.typ',
			onIssues: (value) => issues.push(...value),
		})
		const ui = {
			editable: true,
			composing: false,
			fontFamilies: [],
			slashCommands: [],
			validateDocument: (document: JSONContent) =>
				state.prepareEdit({ projection: state.open('main.typ'), document }).ok,
		}
		try {
			editor.commands.setTextSelection(3)
			const change = prepareLink(editor, ui, { href: 'https://new.example' })
			expect(change).toBeDefined()
			editor.view.dispatch(change!)
			expect(state.snapshot().files['main.typ']).toBe(source.replace('old.example', 'new.example'))
			editor.commands.setTextSelection(3)
			const remove = prepareLink(editor, ui, { remove: true })
			expect(remove).toBeDefined()
			editor.view.dispatch(remove!)
			expect(state.snapshot().files['main.typ']).toBe('Hello /* keep */*world*')
			editor.commands.undo()
			editor.commands.undo()
			expect(state.snapshot().files['main.typ']).toBe(source)
			editor.commands.setTextSelection({ from: 1, to: 6 })
			expect(prepareLink(editor, ui, { href: 'https://partial.example' })).toBeUndefined()
			expect(state.snapshot().files['main.typ']).toBe(source)
			expect(issues).toEqual([])
		} finally {
			editor.destroy()
		}
	})
	it('rejects merges that would discard native cell parameters', () => {
		for (const source of [
			'#table(columns: 2, table.cell(fill: red)[A], table.cell(fill: blue)[A])',
			'#table(columns: 2, table.cell(fill: red)[A], [B])',
		]) {
			const state = createTypstSourceProject({ files: { 'main.typ': source } })
			const issues: unknown[] = []
			const editor = createTypstSourceEditor({
				project: state,
				path: 'main.typ',
				onIssues: (value) => issues.push(...value),
			})
			try {
				editor.view.dispatch(
					editor.state.tr.setSelection(CellSelection.create(editor.state.doc, 2, 7)),
				)
				editor.commands.mergeCells()
				expect(state.snapshot().files['main.typ']).toBe(source)
				expect(issues).not.toEqual([])
			} finally {
				editor.destroy()
			}
		}
	})

	it('native schema defaults preserve headings, links, math labels and code on no-op open/save', () => {
		const source =
			'= 标题 <sec:title>\n\n*粗* _斜_ #underline[线] #strike[删] #sub[下] #super[上] #link("https://example.com")[网站] `code` #text(font: "Noto Serif", size: 12pt, fill: red)[字]\n\n$ x^2 $ <eq:x>\n\n#figure([#image("a.svg")], caption: [图题]) <fig:a>'
		const state = createTypstSourceProject({ files: { 'main.typ': source } })
		const editor = createTypstSourceEditor({ project: state, path: 'main.typ' })
		try {
			const result = state.prepareEdit({
				projection: state.open('main.typ'),
				document: editor.getJSON(),
			})
			if (!result.ok) throw new Error(JSON.stringify(result.issues))
			expect(result).toMatchObject({ ok: true, value: { patches: [] } })
		} finally {
			editor.destroy()
		}
	})
	it('adds a figure caption without corrupting the original call', () => {
		const source = '#figure(image("a.svg"), placement: top) <fig:a>'
		const changed = edit(source, (doc) => {
			all(doc).find((node) => node.type === 'figureCaption')!.content = [
				{ type: 'text', text: '新增题注' },
			]
		})
		expect(changed).toBe('#figure(image("a.svg"), placement: top, caption: [新增题注]) <fig:a>')
		expect(parse(changed).errors).toEqual([])
	})
	it('copies a figure through its source transaction and undoes the complete copy', () => {
		const source =
			'#figure(image("a.svg", width: 80%), caption: [图题 @fig:a], placement: top) <fig:a>'
		const state = createTypstSourceProject({ files: { 'main.typ': source, 'a.svg': '<svg />' } })
		const issues: unknown[] = [],
			editor = createTypstSourceEditor({
				project: state,
				path: 'main.typ',
				onIssues: (value) => issues.push(...value),
			})
		try {
			expect(editor.commands.duplicateTypstFigure(0)).toBe(true)
			const updated = state.snapshot().files['main.typ'] as string
			expect(updated.match(/placement: top/g)).toHaveLength(2)
			expect(state.open('main.typ').labels.map((label) => label.label)).toEqual([
				'fig:a',
				'fig:a-copy',
			])
			expect(updated).toContain('@fig:a-copy')
			expect(editor.commands.undo()).toBe(true)
			expect(state.snapshot().files['main.typ']).toBe(source)
			expect(issues).toEqual([])
		} finally {
			editor.destroy()
		}
	})
	it('rejects prepared copy metadata after an external revision, including unchanged projected text', () => {
		const source = '#figure(image("a.svg"), caption: [图题]) <fig:a>'
		const state = createTypstSourceProject({ files: { 'main.typ': source, 'a.svg': '<svg />' } })
		const issues: { code?: string }[] = [],
			editor = createTypstSourceEditor({
				project: state,
				path: 'main.typ',
				onIssues: (value) => issues.push(...value),
			})
		try {
			const transaction = prepareTypstSourceCopy(editor, state, 'main.typ', 0)!
			state.replace({
				baseRevision: state.revision,
				files: { 'main.typ': source + '\n// external', 'a.svg': '<svg />' },
			})
			editor.view.dispatch(transaction)
			expect(state.snapshot().files['main.typ']).toBe(source + '\n// external')
			expect(issues.some((issue) => issue.code === 'CONFLICT')).toBe(true)
		} finally {
			editor.destroy()
		}
	})

	it('preserves typed repeated spaces, tabs and newlines on source reopen', () => {
		const value = 'A  B\tC\nD'
		const changed = edit('text', (doc) => {
			all(doc).find((node) => node.type === 'text')!.text = value
		})
		expect(
			all(project(changed).document)
				.filter((node) => node.type === 'text')
				.map((node) => node.text)
				.join(''),
		).toBe(value)
		const consecutive = edit('A B', (doc) => {
			all(doc).find((node) => node.type === 'text')!.text = 'A  B'
		})
		expect(all(project(consecutive).document).find((node) => node.type === 'text')?.text).toBe(
			'A  B',
		)
	})
	it('clears known style parameters while preserving computed parameters in the outer call', () => {
		const source =
			'#text(font: "Noto Serif", size: 12pt, fill: red, weight: if true {"bold"} else {"regular"})[hello]'
		const changed = edit(source, (doc) => {
			all(doc).find((node) => node.type === 'text')!.marks = []
		})
		expect(changed).toContain('weight: if true {"bold"} else {"regular"}')
		expect(changed).not.toContain('fill:')
		expect(changed).not.toContain('size:')
		expect(parse(changed).errors).toEqual([])
	})
	it('merges nested text style projections and clears a simple highlight without losing text', () => {
		const source = '#highlight(fill: rgb("ffff00"))[#text(fill: red, size: 18pt)[hello]]'
		const state = createTypstSourceProject({ files: { 'main.typ': source } })
		const issues: unknown[] = [],
			editor = createTypstSourceEditor({
				project: state,
				path: 'main.typ',
				onIssues: (value) => issues.push(...value),
			})
		try {
			expect(editor.getJSON().content![0]!.content![0]!.marks).toHaveLength(1)
			editor.commands.selectAll()
			expect(editor.commands.unsetAllMarks()).toBe(true)
			expect(parse(state.snapshot().files['main.typ'] as string).errors).toEqual([])
			if (issues.length > 0) throw new Error(JSON.stringify(issues))
			expect(
				all(state.open('main.typ').document).find((node) => node.type === 'text')?.marks,
			).toBeUndefined()
			expect(issues).toEqual([])
		} finally {
			editor.destroy()
		}
	})
	it('rejects unsupported candidate attributes instead of accepting their silent loss', () => {
		const p = project('hello'),
			doc = structuredClone(p.document)
		doc.content![0]!.attrs = { unexpected: 'value' }
		expect(prepareTypstSourceEdit(p, doc).ok).toBe(false)
	})
	it('uses real native Editor defaults and commands without a second saved body', () => {
		const source = '#text(fill:red, weight: if true {"bold"} else {"regular"})[*重要事项*]'
		const state = createTypstSourceProject({ files: { 'main.typ': source } })
		const issues: unknown[] = []
		const editor = createTypstSourceEditor({
			project: state,
			path: 'main.typ',
			onIssues: (value) => issues.push(...value),
		})
		try {
			expect(
				state.prepareEdit({ projection: state.open('main.typ'), document: editor.getJSON() }),
			).toMatchObject({ ok: true, value: { patches: [] } })
			editor.commands.setTextSelection({ from: 1, to: 5 })
			expect(editor.commands.unsetBold()).toBe(true)
			expect(state.snapshot().files['main.typ']).toBe(source.replace('*重要事项*', '重要事项'))
			expect(issues).toEqual([])
		} finally {
			editor.destroy()
		}
	})
})

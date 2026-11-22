import type { JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import {
	parseTypstDocument,
	printTypstDocument,
	type TypstDocumentResult,
} from '../src/document/convert.js'

function accepted<T>(result: TypstDocumentResult<T>): T {
	if (result.ok) return result.value
	throw new Error(JSON.stringify(result.issues))
}

describe('Typst editable body conversion', () => {
	it('reopens canonical native chapters with the same semantic tree and bytes', () => {
		const source = `
== 研究目标 <object-goals>

研究见 @chapter-approach。#text(font: "Noto Serif CJK SC", size: 12pt)[中文 _强调_]

- 第一项
  + 子项
- 第二项

#figure(image("/body-assets/architecture.svg", width: 100%), caption: [观察与方案评估。]) <object-architecture>

#table(columns: (1fr, 42pt), table.header([方法], [产出]), [现场观察], [需求记录], table.cell(colspan: 2)[总结])

完成率为 $p = n / N$。

#metadata((__pluxel_reference: true, target: <object-architecture>, show-caption: false))
`
		const opened = accepted(parseTypstDocument(source))
		const written = accepted(printTypstDocument(opened.document))
		const reopened = accepted(parseTypstDocument(written.source))
		expect(reopened.document).toEqual(opened.document)
		expect(written.document).toEqual(opened.document)
		expect(accepted(printTypstDocument(reopened.document)).source).toBe(written.source)
		expect(written.source).toContain('#ref(<chapter-approach>)。')
		expect(written.source).toContain('columns: (1fr, 42pt)')
		expect(written.source).toContain('width: 100%')
		expect(written.source).toContain('$p = n / N$')
	})

	it('preserves literal punctuation, explicit spaces and line breaks in the source it emits', () => {
		const phrase = `  1. @object "text" 😀 // \\' quoted <name> * #body https://example.test  `
		const document: JSONContent = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: phrase },
						{ type: 'hardBreak' },
						{ type: 'text', text: '下一行' },
						{ type: 'reference', attrs: { target: 'object-target' } },
						{ type: 'text', text: ';仍是文字 (而非参数)' },
						{ type: 'reference', attrs: { target: 'object-other' } },
						{ type: 'text', text: '(没有空格)' },
					],
				},
				{ type: 'paragraph' },
				{ type: 'paragraph' },
				{
					type: 'codeBlock',
					attrs: { language: 'typ' },
					content: [{ type: 'text', text: '#text("原样")\n' }],
				},
			],
		}
		const written = accepted(printTypstDocument(document))
		expect(accepted(parseTypstDocument(written.source)).document).toEqual(written.document)
		expect(written.source).toContain('#par[]\n\n#par[]')
		expect(written.source).toContain('#raw(')
		expect(accepted(printTypstDocument(accepted(parseTypstDocument('')).document)).source).toBe('')
	})

	it('maps UTF-8 source glyphs and escaped strings to actual editor positions', () => {
		const source = '前#text("甲\\u{1f600}乙")后'
		const { document, mapping } = accepted(parseTypstDocument(source))
		expect(document.content?.[0]?.content).toEqual([{ type: 'text', text: '前甲😀乙后' }])
		const bytes = new TextEncoder().encode(source)
		const escapeAt = new TextEncoder().encode('前#text("甲').length
		const span = mapping.find(({ from }) => from === escapeAt)
		expect(span).toMatchObject({ kind: 'text', position: 3, endPosition: 5, nodePath: [0, 0] })
		expect(new TextDecoder().decode(bytes.slice(span?.from, span?.to))).toBe('\\u{1f600}')
	})

	it('keeps heading alignment, explicit empty captions, and uniform table widths through edits', () => {
		const source =
			'#heading(level: 2)[#par(justify: true)[研究方法]] <object-method>\n\n' +
			'#figure(image("/body-assets/architecture.svg"), caption: [])\n\n' +
			'#table(columns: (1fr, 1fr), table.header([方法], [产出]), [调查], [研究])'
		const { document } = accepted(parseTypstDocument(source))
		const [heading, , table] = document.content!
		expect(heading?.attrs?.textAlign).toBe('justify')
		expect(table?.attrs?.columnWidths).toEqual(['1fr'])
		for (const row of table!.content!) row.content!.push(structuredClone(row.content![0]!))
		const written = accepted(printTypstDocument(document))
		expect(written.source).toContain('columns: (1fr, 1fr, 1fr)')
		expect(written.source).toContain('caption: []')
		expect(accepted(parseTypstDocument(written.source)).document).toEqual(written.document)
	})

	it.each([
		'第一行\n\n#let value = 1',
		'#text(font: "A" + " B")[计算参数]',
		'#text(size: 12pt, size: 11pt)[重复属性]',
		'#strong[未知函数 #smallcaps[仍须检查]]',
		'#image("../assets/local.svg")',
		'#figure(image("/body-assets/architecture.svg"))',
		'段落中 #image("/body-assets/architecture.svg") 的行内图片',
		'+ First item\n\n+ Second item',
		'定界 $ #1 $',
		'// 不属于可编辑正文',
	])('rejects undisclosed syntax and values in %s', (source) => {
		const result = parseTypstDocument(source)
		expect(result).toMatchObject({
			ok: false,
			issues: expect.arrayContaining([
				expect.objectContaining({
					code: expect.stringMatching(/^(INVALID_TYPST|UNSUPPORTED_SYNTAX)$/),
					from: expect.any(Number),
					to: expect.any(Number),
				}),
			]),
		})
	})

	it.each(['https://inner.test', '#link("https://inner.test")[内层]'])(
		'rejects nested link %s at its source span',
		(inner) => {
			const prefix = '正文 #link("https://outer.test")['
			const encoder = new TextEncoder()
			expect(parseTypstDocument(prefix + inner + ']')).toMatchObject({
				ok: false,
				issues: [
					{
						code: 'UNSUPPORTED_SYNTAX',
						from: encoder.encode(prefix).length,
						to: encoder.encode(prefix + inner).length,
						message: 'Links must not be nested',
					},
				],
			})
		},
	)

	it('uses the same math delimiters at validation and emission', () => {
		const trailingLinebreak = 'x \\'
		const document: JSONContent = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [{ type: 'inlineMath', attrs: { expression: trailingLinebreak } }],
				},
			],
		}
		expect(printTypstDocument(document)).toMatchObject({
			ok: false,
			issues: [
				{
					code: 'INVALID_DOCUMENT',
					path: ['content', 0, 'content', 0, 'attrs', 'expression'],
				},
			],
		})
		const block = accepted(
			printTypstDocument({
				type: 'doc',
				content: [{ type: 'blockMath', attrs: { expression: trailingLinebreak } }],
			}),
		)
		expect(accepted(parseTypstDocument(block.source)).document).toEqual(block.document)
	})

	it('keeps literal math strings and code text separate from actual source syntax', () => {
		const source = '#raw("// This is code text.", block: true)\n\nUse $"$ # here"$ in the example.'
		const written = accepted(printTypstDocument(accepted(parseTypstDocument(source)).document))
		expect(accepted(parseTypstDocument(written.source)).document).toEqual(written.document)
		expect(written.source).toContain('#raw("// This is code text.", block: true)')
		expect(written.source).toContain('$"$ # here"$')
	})

	it.each([
		'https:example.test',
		'https:///example.test',
		'https://example.test/' + String.fromCharCode(0xd800),
	])('rejects URL spellings that cannot be safely shared with Typst and HTML', (href) => {
		expect(
			printTypstDocument({
				type: 'doc',
				content: [
					{
						type: 'paragraph',
						content: [{ type: 'text', text: 'Link', marks: [{ type: 'link', attrs: { href } }] }],
					},
				],
			}),
		).toMatchObject({
			ok: false,
			issues: [
				{
					code: 'INVALID_DOCUMENT',
					path: ['content', 0, 'content', 0, 'marks', 0, 'attrs', 'href'],
				},
			],
		})
	})

	it('requires a bounded snapshot of plain JSON data fields', () => {
		let accessed = false
		const paragraph = {
			type: 'paragraph',
			get text() {
				accessed = true
				return 'A dynamic field'
			},
		}
		expect(printTypstDocument({ type: 'doc', content: [paragraph] })).toMatchObject({
			ok: false,
			issues: [{ code: 'INVALID_DOCUMENT', path: ['content', 0, 'text'] }],
		})
		expect(accessed).toBe(false)

		const content = [{ type: 'paragraph' }]
		Object.defineProperty(content, Symbol.iterator, {
			value() {
				accessed = true
				return [][Symbol.iterator]()
			},
		})
		expect(printTypstDocument({ type: 'doc', content })).toMatchObject({
			ok: false,
			issues: [{ code: 'INVALID_DOCUMENT', path: ['content'] }],
		})
		expect(accessed).toBe(false)

		const tooMany: unknown[] = []
		tooMany.length = 1_000_001
		expect(printTypstDocument({ type: 'doc', content: tooMany })).toMatchObject({
			ok: false,
			issues: [{ code: 'INVALID_DOCUMENT', path: ['content'] }],
		})
	})

	it('rejects unsupported tree fields and formula expressions before writing any Typst', () => {
		expect(
			printTypstDocument({
				type: 'doc',
				content: [{ type: 'paragraph', attrs: { source: '#text("unhandled attribute")' } }],
			}),
		).toEqual({
			ok: false,
			issues: [
				{
					code: 'INVALID_DOCUMENT',
					path: ['content', 0, 'attrs', 'source'],
					message: 'Unknown attribute',
				},
			],
		})
		expect(
			printTypstDocument({
				type: 'doc',
				content: [
					{
						type: 'paragraph',
						content: [{ type: 'inlineMath', attrs: { expression: 'p = #1' } }],
					},
				],
			}),
		).toMatchObject({
			ok: false,
			issues: [
				{
					code: 'INVALID_DOCUMENT',
					path: ['content', 0, 'content', 0, 'attrs', 'expression'],
				},
			],
		})
	})
})

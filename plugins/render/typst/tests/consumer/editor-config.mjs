import { Node, mergeAttributes } from '@tiptap/core'
import { TypstTableStyle } from '@pluxel/plugin-typst/tiptap'
import * as v from 'valibot'

export const fontFamilies = ['Noto Serif CJK SC', 'Liberation Serif']

// This node and button belong to the consumer, including their output meaning.
const Notice = Node.create({
	name: 'notice',
	group: 'block',
	content: 'block+',
	defining: true,
	addAttributes: () => ({
		tone: {
			default: 'info',
			parseHTML: (element) => element.getAttribute('data-tone') ?? 'info',
			renderHTML: (attrs) => ({ 'data-tone': attrs.tone }),
		},
	}),
	parseHTML: () => [{ tag: 'aside[data-consumer-notice]' }],
	renderHTML: ({ node, HTMLAttributes }) => [
		'aside',
		mergeAttributes(HTMLAttributes, {
			'data-consumer-notice': '',
			'data-tone': node.attrs.tone,
		}),
		0,
	],
})

export const config = {
	regions: [
		{ id: 'body', label: '正文', fields: [['customer', 'name']] },
		{ id: 'notes', label: '备注', fields: [['customer', 'name']] },
	],
	fields: [{ path: ['customer', 'name'], label: '客户名称' }],
	extensions: [TypstTableStyle, Notice],
	nodeMappings: {
		notice: {
			validateAttributes: (attrs) => attrs.tone === 'info' || attrs.tone === 'warning',
			html: {
				tag: 'aside',
				attributes: ['data-consumer-notice', 'data-tone'],
				validateAttributes: (attrs) =>
					attrs['data-consumer-notice'] === '' &&
					['info', 'warning'].includes(attrs['data-tone'] ?? 'info'),
			},
			serialize: (node, context) =>
				`#block(fill: rgb("#e8f2ff"), inset: 8pt, width: 100%)[${context.children(node)}]\n`,
		},
	},
}

// The draft stores the raw name. Opening it must never apply this transform twice.
export const schema = v.object({
	customer: v.object({
		name: v.pipe(
			v.string(),
			v.transform((value) => `${value.trim()}!`),
		),
	}),
})
export const parseData = (raw) => v.parse(schema, raw)

const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const cell = (text, attrs = {}, content) => ({
	type: 'tableCell',
	attrs: { colspan: 1, rowspan: 1, colwidth: null, ...attrs },
	content: content ?? [paragraph(text)],
})

export const initialDraft = {
	formatVersion: 1,
	templateId: 'consumer-report',
	templateRevision: 'fixed-v1',
	data: { customer: { name: 'Acme' } },
	regions: {
		body: {
			type: 'doc',
			content: [
				{
					type: 'heading',
					attrs: { level: 2 },
					content: [{ type: 'text', text: 'Editable overview' }],
				},
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: 'Prepared for ' },
						{ type: 'dataField', attrs: { path: ['customer', 'name'] } },
						{
							type: 'text',
							text: ' A😀B #[] "quoted" \\ literal | text',
							marks: [{ type: 'bold' }, { type: 'italic' }],
						},
					],
				},
				{
					type: 'table',
					content: [
						{
							type: 'tableRow',
							content: [cell('Merged heading', { colspan: 2, colwidth: [120, 180] })],
						},
						{
							type: 'tableRow',
							content: [
								cell('', { colwidth: [120] }, [
									paragraph('First paragraph | literal'),
									paragraph('Second paragraph'),
								]),
								cell('', { colwidth: [180] }, [
									{
										type: 'paragraph',
										content: [{ type: 'dataField', attrs: { path: ['customer', 'name'] } }],
									},
								]),
							],
						},
					],
				},
			],
		},
		notes: { type: 'doc', content: [paragraph('Notes ready for a Markdown candidate.')] },
	},
}

export const initialSource = `#set page(width: 400pt, height: 520pt, margin: 32pt)
#set text(font: "DejaVu Sans", size: 11pt)
= Fixed template
Fixed author text A😀B
#include "_editor/regions/body.typ"
#pagebreak()
= Review notes
#include "_editor/regions/notes.typ"
#pagebreak()
= Repeated body
#include "_editor/regions/body.typ"
`

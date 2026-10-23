import * as v from 'valibot'
import { TypstTableStyle, TypstTemplateBlock, TypstSource } from '@pluxel/plugin-typst/tiptap'
import { config, initialDraft, initialSource, parseData } from './editor-config.mjs'
import data from './public/examples/operations-report.json' with { type: 'json' }

const amount = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1_000_000))
const schema = v.strictObject({
	company: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
	period: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
	analyst: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
	channels: v.pipe(
		v.array(
			v.strictObject({
				name: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
				actual: amount,
				target: amount,
			}),
		),
		v.minLength(1),
		v.maxLength(8),
	),
})
const fields = [
	{ path: ['company'], label: '公司名称' },
	{ path: ['period'], label: '报告期间' },
	{ path: ['analyst'], label: '负责人' },
]
const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const row = (texts, header = false) => ({
	type: 'tableRow',
	content: texts.map((text) => ({
		type: header ? 'tableHeader' : 'tableCell',
		content: [paragraph(text)],
	})),
})
const channelTemplate = {
	id: 'channels',
	label: '渠道收入与目标',
	defaults: { title: '渠道收入与目标' },
	validateProps: (props) =>
		Object.keys(props).every((key) => key === 'title') &&
		typeof props.title === 'string' &&
		props.title.length > 0,
	source:
		'#let green = rgb("#28745c")\n#let pale = rgb("#eaf3ee")\n#let total = data.channels.map(item => item.actual).sum()\n#let target = data.channels.map(item => item.target).sum()\n#let amount(value) = str(calc.round(value, digits: 1))\n#let rate(actual, target) = if target == 0 { "—" } else { str(calc.round(actual / target * 100, digits: 1)) + "%" }\n#let maximum = calc.max(1, ..data.channels.map(item => calc.max(item.actual, item.target)))\n\n#grid(columns: (1fr, 1fr, 1fr), gutter: 8pt,\n  block(fill: pale, inset: 10pt, width: 100%)[实际收入（万元） #linebreak() #text(size: 19pt)[#amount(total)]],\n  block(fill: pale, inset: 10pt, width: 100%)[目标收入（万元） #linebreak() #text(size: 19pt)[#amount(target)]],\n  block(fill: pale, inset: 10pt, width: 100%)[达成率 #linebreak() #text(size: 19pt)[#rate(total, target)]],\n)\n\n#heading(level: 1)[#props.title]\n#grid(columns: (1fr, 1.1fr), gutter: 16pt,\n  [\n    #text(size: 8pt)[深色：实际 · 浅色：目标 / 单位：万元]\n    #v(6pt)\n    #for item in data.channels [\n      #text(size: 9pt, weight: "bold")[#item.name]\n      #grid(columns: (1fr, 28pt), column-gutter: 5pt, row-gutter: 3pt,\n        rect(width: item.actual / maximum * 100%, height: 7pt, fill: green, stroke: none),\n        text(size: 8pt, amount(item.actual)),\n        rect(width: item.target / maximum * 100%, height: 7pt, fill: rgb("#bed7cb"), stroke: none),\n        text(size: 8pt, amount(item.target)),\n      )\n      #v(6pt)\n    ]\n  ],\n  [\n    #set text(size: 9pt)\n    #table(columns: (1.2fr, .8fr, .8fr, .9fr), stroke: none, inset: 5pt,\n      align: (left, right, right, right),\n      table.header(table.hline(stroke: 1pt + green), [渠道], [实际], [目标], [达成率], table.hline(stroke: .5pt + green)),\n      ..data.channels.map(item => (item.name, amount(item.actual), amount(item.target), rate(item.actual, item.target))).flatten(),\n      table.hline(stroke: 1pt + green),\n    )\n  ],\n)\n#text(size: 8pt, fill: rgb("#587064"))[图与表使用同一份输入数据、相同零起点与比例；目标为零时不计算达成率。]\n\n',
}
const reportConfig = {
	...config,
	fields,
	regions: [
		{ id: 'body', label: '经营解读' },
		{ id: 'notes', label: '后续行动' },
	],
	extensions: [
		TypstTemplateBlock.configure({ templates: [channelTemplate] }),
		TypstSource,
		TypstTableStyle.configure({ defaultStyle: 'three-line' }),
		...config.extensions.filter((extension) => extension.name !== 'typstTableStyle'),
	],
	resolveImage: (id) =>
		id === 'examples/operations-cover.svg' ? { path: '/inputs/report/cover.svg' } : undefined,
}
const reportDraft = {
	formatVersion: 1,
	templateId: 'operations-report',
	templateRevision: 'operations-v1',
	data,
	regions: {
		body: {
			type: 'doc',
			content: [
				{
					type: 'image',
					attrs: {
						src: 'examples/operations-cover.svg',
						alt: '青山品牌插图',
						width: 500,
						height: 125,
					},
				},
				{
					type: 'paragraph',
					content: [
						{ type: 'dataField', attrs: { path: ['company'] } },
						{ type: 'text', text: ' 在 ' },
						{ type: 'dataField', attrs: { path: ['period'] } },
						{ type: 'text', text: ' 的渠道表现见图表。请在这里补充原因、风险与下一步判断。' },
					],
				},
				{
					type: 'templateBlock',
					attrs: {
						id: 'channels-primary',
						template: 'channels',
						props: { title: '渠道收入与目标' },
						dataPath: [],
					},
				},
				{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '经营解读' }] },
				{
					type: 'table',
					attrs: { typstTableStyle: 'three-line' },
					content: [
						row(['观察', '证据与建议'], true),
						row(['企业服务增长', '核对新增客户与续约贡献，优先复盘可持续的收入来源。']),
						row(['订阅目标差异', '补充转化率、流失原因与下季度跟进计划。']),
					],
				},
			],
		},
		notes: {
			type: 'doc',
			content: [
				paragraph('本区的行动计划由用户维护，替换输入数据不会重建这张表。'),
				{
					type: 'typstSource',
					attrs: {
						id: 'source-note',
						source:
							'#text(size: 9pt, fill: gray)[核验记录：#data.analyst · 本段可编辑原始 Typst。]',
					},
				},
				{
					type: 'table',
					attrs: { typstTableStyle: 'borderless' },
					content: [
						row(['行动', '负责人 / 交付']),
						{
							type: 'tableRow',
							content: [
								{ type: 'tableCell', content: [paragraph('复盘高于目标的渠道')] },
								{
									type: 'tableCell',
									content: [
										{
											type: 'paragraph',
											content: [
												{ type: 'dataField', attrs: { path: ['analyst'] } },
												{ type: 'text', text: ' / 原因分析与客户清单' },
											],
										},
									],
								},
							],
						},
						row(['安排客户回访', '渠道团队 / 确认回款与续约计划']),
					],
				},
			],
		},
	},
}

export const examples = [
	{
		id: initialDraft.templateId,
		label: '基础编辑与定位',
		draft: initialDraft,
		config,
		parseData,
		source: initialSource,
	},
	{
		id: reportDraft.templateId,
		label: '图表报告 · 外部数据与模板',
		draft: reportDraft,
		config: reportConfig,
		parseData: (raw) => v.parse(schema, raw),
		templateUrl: '/examples/operations-report.typ',
	},
]
export function getExample(id) {
	const example = examples.find((item) => item.id === id)
	if (!example) throw new Error(`Unknown example: ${id}`)
	return example
}

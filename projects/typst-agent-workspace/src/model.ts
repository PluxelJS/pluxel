import * as v from 'valibot'
import {
	TypstTableStyle,
	TypstTemplateBlock,
	type JSONContent,
	type TypstDocumentDraft,
	type TypstEditorConfig,
} from '@pluxel/plugin-typst/tiptap'

export const templateId = 'quarterly-operations'
export const templateRevision = '1'
export const dataSchema = v.strictObject({
	company: v.string(),
	quarter: v.string(),
	revenue: v.number(),
	previousRevenue: v.number(),
	renewalRate: v.number(),
})
const summaryProps = v.strictObject({ title: v.pipe(v.string(), v.minLength(1)) })

export const config: TypstEditorConfig = {
	regions: [
		{ id: 'analysis', label: '经营分析', marks: ['bold', 'italic', 'link', 'code'] },
		{ id: 'actions', label: '行动建议', marks: ['bold', 'italic', 'link', 'code'] },
	],
	fields: [
		{ path: ['company'], label: '公司名称' },
		{ path: ['quarter'], label: '报告季度' },
	],
	extensions: [
		TypstTableStyle,
		TypstTemplateBlock.configure({
			templates: [
				{
					id: 'metrics',
					label: '指标卡',
					defaults: { title: '核心指标' },
					validateProps: (props) =>
						v.safeParse(summaryProps, props).success ||
						'title 必须为非空字符串，且不能添加未知参数',
					source:
						'#block(fill: rgb("eef4fa"), inset: 10pt, width: 100%)[#strong(props.title) #linebreak() 营收：#data.revenue 万元；续约率：#data.renewalRate%]',
				},
			],
		}),
	],
	resolveImage: (id) =>
		id === 'revenue-chart' ? { path: '/inputs/assets/revenue.svg' } : undefined,
}

const text = (value: string): JSONContent => ({ type: 'text', text: value })
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const cell = (value: string, header = false): JSONContent => ({
	type: header ? 'tableHeader' : 'tableCell',
	content: [paragraph(text(value))],
})

export function initialDraft(): TypstDocumentDraft {
	return {
		formatVersion: 1,
		templateId,
		templateRevision,
		data: {
			company: '北辰软件',
			quarter: '2026 Q3',
			revenue: 120,
			previousRevenue: 100,
			renewalRate: 91,
		},
		regions: {
			analysis: {
				type: 'doc',
				content: [
					paragraph({ type: 'dataField', attrs: { path: ['company'] } }, text(' · '), {
						type: 'dataField',
						attrs: { path: ['quarter'] },
					}),
					paragraph(text('本季度营收增长，详细原因待补充。')),
					{
						type: 'figure',
						attrs: { id: 'revenue-figure', label: 'fig:revenue' },
						content: [
							{ type: 'image', attrs: { src: 'revenue-chart', alt: '季度营收对比', width: 380 } },
							{ type: 'figureCaption', content: [text('季度营收对比，单位：万元。')] },
						],
					},
					{
						type: 'table',
						content: [
							{ type: 'tableRow', content: [cell('渠道', true), cell('营收（万元）', true)] },
							{ type: 'tableRow', content: [cell('直销'), cell('75')] },
							{ type: 'tableRow', content: [cell('合作伙伴'), cell('45')] },
						],
					},
					{
						type: 'templateBlock',
						attrs: {
							id: 'metrics-1',
							template: 'metrics',
							props: { title: '核心指标' },
							dataPath: [],
						},
					},
					{
						type: 'table',
						attrs: { tableStyle: 'three-line' },
						content: [
							{
								type: 'tableRow',
								content: [
									{
										type: 'tableHeader',
										attrs: { colspan: 2 },
										content: [paragraph(text('补充口径（保留合并结构）'))],
									},
								],
							},
							{
								type: 'tableRow',
								content: [
									{
										type: 'tableCell',
										content: [paragraph(text('收入确认')), paragraph(text('按已验收合同统计。'))],
									},
									cell('不含税'),
								],
							},
						],
					},
				],
			},
			actions: {
				type: 'doc',
				content: [
					paragraph(
						text('营收趋势见 '),
						{ type: 'reference', attrs: { target: 'revenue-figure' } },
						text('。'),
					),
					paragraph(text('请补充三条有负责人和验收标准的行动建议。')),
				],
			},
		},
	}
}

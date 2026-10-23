/** A consumer-owned report: business data and layout stay outside the editor schema. */
const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const cell = (text: string, header = false) => ({
	type: header ? 'tableHeader' : 'tableCell',
	content: [paragraph(text)],
})
const row = (values: string[], header = false) => ({
	type: 'tableRow',
	content: values.map((value) => cell(value, header)),
})

const channelChartSource = `#let actual = data.channels.map(channel => channel.actual).sum()
#let target = data.channels.map(channel => channel.target).sum()
#let amount(value) = str(calc.round(value, digits: 1))
#let attainment(value, goal) = if goal == 0 { "—" } else { str(calc.round(value / goal * 100, digits: 1)) + "%" }
#let blue = rgb("#2563eb")
#let grey = rgb("#cbd5e1")
#let ceiling = calc.max(1, ..data.channels.map(channel => calc.max(channel.actual, channel.target)))

#grid(columns: (1fr, 1fr, 1fr), gutter: 8pt,
  block(fill: rgb("#eff6ff"), inset: 10pt, width: 100%)[实际收入（万元） #linebreak() #text(size: 17pt, weight: "bold")[#amount(actual)]],
  block(fill: rgb("#f1f5f9"), inset: 10pt, width: 100%)[目标收入（万元） #linebreak() #text(size: 17pt, weight: "bold")[#amount(target)]],
  block(fill: rgb("#f0fdfa"), inset: 10pt, width: 100%)[目标达成率 #linebreak() #text(size: 17pt, weight: "bold")[#attainment(actual, target)]],
)

= #props.title
#grid(columns: (1fr, 1.15fr), gutter: 14pt,
  [
    #text(size: 9pt)[#box(width: 8pt, height: 8pt, fill: blue) 实际 #h(8pt) #box(width: 8pt, height: 8pt, fill: grey) 目标]
    #v(5pt)
    #for channel in data.channels [
      #text(size: 9pt, weight: "bold")[#channel.name]
      #grid(columns: (1fr, 30pt), column-gutter: 5pt, row-gutter: 3pt,
        rect(width: channel.actual / ceiling * 100%, height: 7pt, fill: blue, stroke: none),
        text(size: 8pt, amount(channel.actual)),
        rect(width: channel.target / ceiling * 100%, height: 7pt, fill: grey, stroke: none),
        text(size: 8pt, amount(channel.target)),
      )
      #v(5pt)
    ]
    #text(size: 8pt, fill: luma(100))[柱长使用同一零起点与比例；单位：万元。]
  ],
  [
    #table(
      stroke: (x, y) => (bottom: if y == 0 { 0.7pt } else { 0.3pt }),
      columns: (1.3fr, 1fr, 1fr, 1fr),
      align: (left, right, right, right),
      table.header([渠道], [实际], [目标], [达成率]),
      ..data.channels.map(channel => (channel.name, amount(channel.actual), amount(channel.target), attainment(channel.actual, channel.target))).flatten(),
    )
  ],
)
#text(size: 8pt, fill: luma(100))[图与明细表读取同一份已校验的渠道数据；目标为零时达成率显示“—”，所有收入为零时柱长为零。]
`

export const chartReportSeed: Record<string, string> = {
	'报表/图表分析报告/图表分析报告.ts': `import { defineTypstDocument } from '@pluxel/plugin-typst/template'
import * as v from 'valibot'

export default defineTypstDocument({
  template: './排版.typ',
  schema: v.object({
    company: v.optional(v.pipe(v.string(), v.title('公司名称')), '青山科技有限公司'),
    period: v.optional(v.pipe(v.string(), v.title('报告期间')), '2026 年第三季度'),
    analyst: v.optional(v.pipe(v.string(), v.title('分析负责人')), '陈晓'),
    channels: v.optional(v.pipe(v.array(v.object({
      name: v.pipe(v.string(), v.minLength(1), v.title('渠道名称')),
      actual: v.pipe(v.number(), v.minValue(0), v.title('实际收入（万元）')),
      target: v.pipe(v.number(), v.minValue(0), v.title('目标收入（万元）')),
    })), v.minLength(1), v.maxLength(8), v.title('渠道收入')), [
      { name: '企业服务', actual: 168, target: 150 },
      { name: '平台订阅', actual: 112, target: 120 },
      { name: '技术咨询', actual: 76, target: 80 },
      { name: '培训支持', actual: 44, target: 50 },
    ]),
  }),
})
`,
	'报表/图表分析报告/排版.typ': `#import "../../共享/主题/财务函件.typ": correspondence
#let data = json("/inputs/editor/data.json")
#set page(header: align(right, text(size: 9pt, fill: luma(90), [#data.company · #data.period])))
#show: correspondence.with(title: [渠道收入与行动分析], numbering: "1")
#set text(size: 10pt)

#include "../../_editor/regions/analysis.typ"

= 跟进计划
#include "../../_editor/regions/actions.typ"

#line(length: 100%, stroke: 0.4pt + luma(190))
#text(size: 8pt, fill: luma(100))[固定口径：本示例收入以万元展示，用于业务沟通；图表定义由模板负责，顺序由正文决定。分析负责人：#data.analyst。]
`,
	'报表/图表分析报告/图表分析报告.editor.json': JSON.stringify(
		{
			templates: [
				{
					id: 'channel-performance',
					label: '渠道收入与目标',
					source: channelChartSource,
					defaults: { title: '渠道收入与目标' },
				},
			],
			sourceBlocks: true,
			table: {
				defaultStyle: 'three-line',
				allowedStyles: ['grid', 'grid-open-sides', 'three-line', 'borderless'],
			},
			regions: [
				{ id: 'analysis', label: '分析说明', fields: [['company'], ['period'], ['analyst']] },
				{ id: 'actions', label: '跟进计划', fields: [['analyst']] },
			],
			fields: [
				{ path: ['company'], label: '公司名称' },
				{ path: ['period'], label: '报告期间' },
				{ path: ['analyst'], label: '分析负责人' },
			],
			defaults: {
				analysis: {
					type: 'doc',
					content: [
						{
							type: 'paragraph',
							content: [
								{ type: 'dataField', attrs: { path: ['company'] } },
								{ type: 'text', text: ' · ' },
								{ type: 'dataField', attrs: { path: ['period'] } },
								{ type: 'text', text: '：请结合图表补充渠道差异、风险和下一步判断。' },
							],
						},
						{
							type: 'templateBlock',
							attrs: {
								id: 'channel-chart',
								template: 'channel-performance',
								props: { title: '渠道收入与目标' },
								dataPath: [],
							},
						},
						paragraph(
							'经营解读：企业服务收入超过目标，订阅渠道仍有提升空间。可以将图表移到这段解读后，再用 Markdown 候选单独改写文字。',
						),
						{
							type: 'table',
							attrs: { typstTableStyle: 'borderless' },
							content: [
								row(['观察重点', '需要补充的证据']),
								row(['高于目标的渠道', '确认增长是否来自可持续的订阅或续约。']),
								row(['低于目标的渠道', '核对销售周期、回款进展与下季转化计划。']),
							],
						},
						{
							type: 'typstSource',
							attrs: {
								id: 'analysis-note',
								source:
									'#text(size: 8pt, fill: luma(100))[补充口径：这是可编辑的 Typst 源码块，可以移动或改成公式、脚注。]',
							},
						},
					],
				},
				actions: {
					type: 'doc',
					content: [
						{
							type: 'table',
							attrs: { typstTableStyle: 'three-line' },
							content: [
								row(['行动', '负责人', '验收方式'], true),
								{
									type: 'tableRow',
									content: [
										cell('复盘渠道收入与目标差异'),
										{
											type: 'tableCell',
											content: [
												{
													type: 'paragraph',
													content: [{ type: 'dataField', attrs: { path: ['analyst'] } }],
												},
											],
										},
										cell('提交分渠道原因与支持材料'),
									],
								},
								row(['确认下期客户跟进清单', '渠道团队', '为每项机会填写责任人与日期']),
							],
						},
					],
				},
			},
		},
		null,
		2,
	),
	'报表/图表分析报告/示例输入.json': JSON.stringify(
		{
			company: '远山数字服务有限公司',
			period: '2026 年第四季度',
			analyst: '王宁',
			channels: [
				{ name: '企业服务', actual: 210, target: 200 },
				{ name: '平台订阅', actual: 156, target: 140 },
				{ name: '技术咨询', actual: 92, target: 100 },
			],
		},
		null,
		2,
	),
}

/** A consumer-owned report: business data and layout stay outside the editor schema. */
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

#block(above: 8pt, below: 6pt)[#text(size: 12pt, weight: "bold")[#title]]
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
#text(size: 8pt, fill: luma(100))[单位：万元。柱长采用统一零起点与比例；目标为零时达成率显示“—”。]
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
	'报表/图表分析报告/排版.typ': `#import "../../lib/pluxel.typ" as report
#show: report.document
#import "../../共享/主题/财务函件.typ": correspondence
#let data = json("data.json")
#set page(header: align(right, text(size: 9pt, fill: luma(90), [#data.company · #data.period])))
#show: correspondence.with(title: [渠道收入与行动分析], numbering: "1")
#set text(size: 10pt, lang: "zh")
#set math.equation(numbering: "(1)")
#show figure.where(kind: table): set figure.caption(position: top)
#show figure.where(kind: table): set block(breakable: true)

#include "analysis.typ"

= 跟进计划
#include "actions.typ"

#line(length: 100%, stroke: 0.4pt + luma(190))
#text(size: 8pt, fill: luma(100))[报告口径：收入以万元展示；总达成率按收入合计计算，不取渠道达成率的平均值。分析负责人：#data.analyst。]
`,
	'报表/图表分析报告/图表分析报告.editor.json': JSON.stringify(
		{
			sources: [
				{ path: 'analysis.typ', label: '分析说明' },
				{ path: 'actions.typ', label: '跟进计划' },
			],
			components: [
				{
					module: 'chart.typ',
					name: 'channels',
					label: '渠道收入与目标',
					parameters: { title: { type: 'string', label: '标题' } },
					data: 'data',
				},
			],
		},
		null,
		2,
	),
	'报表/图表分析报告/chart.typ':
		'#let channels(title: "渠道收入与目标", data: (:)) = [\n' + channelChartSource + '\n]\n',
	'报表/图表分析报告/analysis.typ': String.raw`#import "../../lib/pluxel.typ" as report
#import "chart.typ" as chart
#let data = json("data.json")
#report.field(json("data.json"), ("company",)) · #report.field(json("data.json"), ("period",))：本报告对比渠道收入与目标，结合客户明细核验收入差异，形成下一步判断。

#figure(chart.channels(title: "渠道收入与目标", data: json("data.json")), caption: [各渠道收入与目标对比]) <fig:channels>

目标达成率以 r 表示，其中 A 为实际收入、T 为目标收入，单位均为万元。仅在 T > 0 时按下式计算。

#report.latex("r = \\frac{A}{T} \\times 100\\%", block: true) <eq:attainment>

经营解读：对高于目标的渠道核对新增客户、续约及一次性收入贡献；对低于目标的渠道核对销售周期与回款进展，避免仅凭达成率判断增长质量。

#figure(table(columns: (1fr, 2fr), stroke: (x,y) => (bottom: if y == 0 {0.7pt} else {0.3pt}),
 table.header([观察重点], [需要补充的证据]),
 [高于目标的渠道], [确认增长是否来自可持续的订阅或续约。],
 [低于目标的渠道], [核对销售周期、回款进展与下季转化计划。],
), caption: [经营观察及核验建议]) <tbl:observations>

#text(size: 8pt, fill: luma(100))[核验负责人：#data.analyst。收入与回款分别核对，未确认的差异不提前归因。]
`,
	'报表/图表分析报告/actions.typ': `#import "../../lib/pluxel.typ" as report
结合 @fig:channels 和 @tbl:observations 制定行动计划；达成率按 @eq:attainment 计算。复盘结论应附客户与回款明细，便于后续核验。

#table(columns: (2fr, 1fr, 2fr), stroke: (x,y) => (bottom: if y == 0 {0.7pt} else {0.3pt}),
 table.header([行动], [负责人], [验收方式]),
 [复盘渠道收入与目标差异], [#report.field(json("data.json"), ("analyst",))], [提交分渠道原因与支持材料],
 [确认下期客户跟进清单], [渠道团队], [为每项机会填写责任人与日期],
)
`,
	'报表/图表分析报告/data.json': JSON.stringify(
		{
			company: '青山科技有限公司',
			period: '2026 年第三季度',
			analyst: '陈晓',
			channels: [
				{ name: '企业服务', actual: 168, target: 150 },
				{ name: '平台订阅', actual: 112, target: 120 },
				{ name: '技术咨询', actual: 76, target: 80 },
				{ name: '培训支持', actual: 44, target: 50 },
			],
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

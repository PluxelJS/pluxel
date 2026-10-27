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
const figure = (id, label, body, caption) => ({
	type: 'figure',
	attrs: { id, label },
	content: [body, { type: 'figureCaption', content: [{ type: 'text', text: caption }] }],
})
const reference = (target, showCaption = null) => ({
	type: 'reference',
	attrs: { target, showCaption },
})
const row = (texts, header = false) => ({
	type: 'tableRow',
	content: texts.map((text) => ({
		type: header ? 'tableHeader' : 'tableCell',
		content: [paragraph(text)],
	})),
})
export const channelTemplate = {
	id: 'channels',
	label: '渠道收入与目标',
	defaults: { title: '渠道收入与目标' },
	validateProps: (props) =>
		Object.keys(props).every((key) => key === 'title') &&
		typeof props.title === 'string' &&
		props.title.length > 0,
	source: `#let green = rgb("#28745c")
#let pale = rgb("#eaf3ee")
#let total = data.channels.map(item => item.actual).sum()
#let target = data.channels.map(item => item.target).sum()
#let amount(value) = str(calc.round(value, digits: 1))
#let rate(actual, target) = if target == 0 { "—" } else { str(calc.round(actual / target * 100, digits: 1)) + "%" }
#let maximum = calc.max(1, ..data.channels.map(item => calc.max(item.actual, item.target)))

#grid(columns: (1fr, 1fr, 1fr), gutter: 8pt,
  block(fill: pale, inset: 10pt, width: 100%)[实际收入（万元） #linebreak() #text(size: 19pt)[#amount(total)]],
  block(fill: pale, inset: 10pt, width: 100%)[目标收入（万元） #linebreak() #text(size: 19pt)[#amount(target)]],
  block(fill: pale, inset: 10pt, width: 100%)[达成率 #linebreak() #text(size: 19pt)[#rate(total, target)]],
)

#block(above: 8pt, below: 6pt)[#text(size: 12pt, weight: "bold")[#props.title]]
#grid(columns: (1fr, 1.1fr), gutter: 16pt,
  [
    #text(size: 8pt)[深色：实际 · 浅色：目标 / 单位：万元]
    #v(6pt)
    #for item in data.channels [
      #text(size: 9pt, weight: "bold")[#item.name]
      #grid(columns: (1fr, 28pt), column-gutter: 5pt, row-gutter: 3pt,
        rect(width: item.actual / maximum * 100%, height: 7pt, fill: green, stroke: none),
        text(size: 8pt, amount(item.actual)),
        rect(width: item.target / maximum * 100%, height: 7pt, fill: rgb("#bed7cb"), stroke: none),
        text(size: 8pt, amount(item.target)),
      )
      #v(6pt)
    ]
  ],
  [
    #set text(size: 9pt)
    #table(columns: (1.2fr, .8fr, .8fr, .9fr), stroke: none, inset: 5pt,
      align: (left, right, right, right),
      table.header(table.hline(stroke: 1pt + green), [渠道], [实际], [目标], [达成率], table.hline(stroke: .5pt + green)),
      ..data.channels.map(item => (item.name, amount(item.actual), amount(item.target), rate(item.actual, item.target))).flatten(),
      table.hline(stroke: 1pt + green),
    )
  ],
)
#text(size: 8pt, fill: rgb("#587064"))[单位：万元。柱长采用统一零起点与比例；目标为零时达成率显示“—”。]

`,
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

const styleSamples = [
	{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '排版与结构试用' }] },
	paragraph(
		'下面的内容都可直接编辑。选中文字改格式，选中表格调整行列、合并或边框；每次修改都可以撤销，也可以切换到 Markdown 对照。',
	),
	{
		type: 'paragraph',
		content: [
			{ type: 'text', text: '重点结论', marks: [{ type: 'bold' }] },
			{ type: 'text', text: ' · ' },
			{ type: 'text', text: '分析备注', marks: [{ type: 'italic' }] },
			{ type: 'text', text: ' · ' },
			{ type: 'text', text: '待确认项', marks: [{ type: 'underline' }] },
			{ type: 'text', text: ' · ' },
			{ type: 'text', text: '已撤回计划', marks: [{ type: 'strike' }] },
			{ type: 'text', text: ' · ' },
			{ type: 'text', text: 'actual / target', marks: [{ type: 'code' }] },
			{ type: 'text', text: ' · ' },
			{
				type: 'text',
				text: 'Typst 排版文档',
				marks: [{ type: 'link', attrs: { href: 'https://typst.app/docs/' } }],
			},
		],
	},
	{
		type: 'paragraph',
		content: [
			{
				type: 'text',
				text: 'Revenue review',
				marks: [
					{
						type: 'textStyle',
						attrs: { fontFamily: 'Liberation Serif', fontSize: '16pt', color: '#27664d' },
					},
				],
			},
			{ type: 'text', text: '　更换字体与字号；' },
			{
				type: 'text',
				text: '高亮待核验数据',
				marks: [{ type: 'textStyle', attrs: { color: '#8a4a16', backgroundColor: '#fff0c2' } }],
			},
			{ type: 'text', text: '。清除显式样式后跟随模板。' },
		],
	},
	...[
		['left', '左对齐：把结论放在段落起点，适合正文与说明。'],
		['center', '居中：季度复盘 · 共同确认'],
		['right', '右对齐：经营分析组 / 2026 年 10 月'],
		[
			'justify',
			'两端对齐：各渠道采用同一统计口径，收入、目标与回款分开核对。对超出预期的增长保留客户明细，对尚未确认的差异说明来源，再把核验结果整理成可执行的后续行动。',
		],
	].map(([textAlign, value]) => ({
		type: 'paragraph',
		attrs: { textAlign },
		content: [{ type: 'text', text: value }],
	})),
	{
		type: 'blockquote',
		content: [paragraph('先确认口径，再解释差异。引用块适合保留原始反馈或强调共同约定。')],
	},
	{
		type: 'notice',
		attrs: { tone: 'info' },
		content: [
			paragraph(
				'核对提醒：目标为零时不计算达成率；收入增长不等于回款已完成。这个提示块也可以通过“插入”或 / 添加。',
			),
		],
	},
	{
		type: 'heading',
		attrs: { level: 3 },
		content: [{ type: 'text', text: '分层行动与代码示例' }],
	},
	{
		type: 'bulletList',
		content: [
			{
				type: 'listItem',
				content: [
					paragraph('补全核验材料'),
					{
						type: 'bulletList',
						content: [
							{ type: 'listItem', content: [paragraph('新增客户与续约明细')] },
							{ type: 'listItem', content: [paragraph('未回款项目及预计到账日期')] },
						],
					},
				],
			},
			{
				type: 'listItem',
				content: [paragraph('在块前操作柄中复制、移动或删除；选中后也可用列表缩进操作。')],
			},
		],
	},
	{
		type: 'orderedList',
		attrs: { start: 1 },
		content: [
			{ type: 'listItem', content: [paragraph('确认统计范围。')] },
			{
				type: 'listItem',
				content: [
					paragraph('按渠道逐项核验。'),
					{
						type: 'orderedList',
						attrs: { start: 1 },
						content: [
							{ type: 'listItem', content: [paragraph('先比较目标与实际。')] },
							{ type: 'listItem', content: [paragraph('再核对客户与回款。')] },
						],
					},
				],
			},
			{ type: 'listItem', content: [paragraph('更新结论并导出当前 PDF。')] },
		],
	},
	{
		type: 'codeBlock',
		attrs: { language: 'javascript' },
		content: [
			{
				type: 'text',
				text: 'const rate = target > 0 ? actual / target * 100 : null\n// 代码块仅展示文字，不执行代码。',
			},
		],
	},
	{ type: 'horizontalRule' },
	{
		type: 'paragraph',
		content: [
			{ type: 'text', text: '同一段中的手动换行：负责人确认' },
			{ type: 'hardBreak' },
			{ type: 'text', text: '下一行补充交付日期；Shift+Enter 可继续换行。' },
		],
	},
	{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '表格样式对照' }] },
	paragraph(
		'下面分别展示继承、网格、无左右框、三线表与无边框。点击任意单元格后，可在表格工具中切换样式、增删行列或调整列宽。',
	),
	...[
		['跟随默认样式', null],
		['完整网格', 'grid'],
		['网格 · 无左右框', 'grid-open-sides'],
		['三线表', 'three-line'],
		['无边框', 'borderless'],
	].flatMap(([name, typstTableStyle]) => [
		{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: name }] },
		{
			type: 'table',
			attrs: { typstTableStyle },
			content: [
				row(['检查项', '状态'], true),
				row(['收入与目标', '已核对']),
				row(['客户与回款', '跟进中']),
			],
		},
	]),
	{
		type: 'heading',
		attrs: { level: 3 },
		content: [{ type: 'text', text: '合并单元格与多段内容' }],
	},
	{
		type: 'table',
		attrs: { typstTableStyle: 'grid' },
		content: [
			row(['阶段', '核验事项', '交付内容'], true),
			{
				type: 'tableRow',
				content: [
					{ type: 'tableCell', attrs: { rowspan: 2 }, content: [paragraph('准备')] },
					{ type: 'tableCell', content: [paragraph('补全资料')] },
					{ type: 'tableCell', content: [paragraph('客户清单'), paragraph('收入与回款明细')] },
				],
			},
			row(['确认口径', '同一期间、同一统计范围']),
			{
				type: 'tableRow',
				content: [
					{ type: 'tableCell', attrs: { colspan: 2 }, content: [paragraph('汇总并确认')] },
					{ type: 'tableCell', content: [paragraph('负责人签字，保留核验记录')] },
				],
			},
		],
	},
]
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
						{ type: 'text', text: ' 的渠道收入与目标对比如下。' },
						{
							type: 'text',
							text: '结合客户明细核验收入差异，形成下一步判断。',
							marks: [
								{
									type: 'textStyle',
									attrs: {
										fontFamily: 'Noto Serif CJK SC',
										fontSize: '12pt',
										color: '#28745c',
										backgroundColor: '#eaf3ee',
									},
								},
							],
						},
					],
				},
				figure(
					'channels-figure',
					'fig:channels',
					{
						type: 'templateBlock',
						attrs: {
							id: 'channels-primary',
							template: 'channels',
							props: { title: '渠道收入与目标' },
							dataPath: [],
						},
					},
					'各渠道收入及目标对比',
				),
				{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '经营解读' }] },
				figure(
					'observations-table',
					'tbl:observations',
					{
						type: 'table',
						attrs: { typstTableStyle: 'three-line' },
						content: [
							row(['观察', '证据与建议'], true),
							row(['企业服务增长', '核对新增客户与续约贡献，优先复盘可持续的收入来源。']),
							row(['订阅目标差异', '补充转化率、流失原因与下季度跟进计划。']),
						],
					},
					'经营观察及核验建议',
				),
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '目标达成率以 ' },
						{ type: 'inlineMath', attrs: { latex: 'r' } },
						{ type: 'text', text: ' 表示，统一按下式计算。' },
					],
				},
				{
					type: 'blockMath',
					attrs: {
						id: 'attainment-equation',
						label: 'eq:attainment',
						latex: 'r = \\frac{A}{T} \\times 100\\%',
					},
				},
				paragraph(
					'其中 A 为实际收入、T 为目标收入，单位均为万元。仅在 T > 0 时计算；总达成率按收入合计计算，不取渠道达成率的平均值。',
				),
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '同一张图的引用：跟随模板 ' },
						reference('channels-figure'),
						{ type: 'text', text: '；仅编号 ' },
						reference('channels-figure', false),
						{ type: 'text', text: '；编号与图题 ' },
						reference('channels-figure', true),
						{ type: 'text', text: '。点击引用可更改显示形式，预览中点击可跳回原图。' },
					],
				},
			],
		},
		notes: {
			type: 'doc',
			content: [
				paragraph('以下行动计划明确差异复盘、客户回访的责任人与交付物。'),
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: '跟进重点参见 ' },
						reference('channels-figure'),
						{ type: 'text', text: ' 和 ' },
						reference('observations-table'),
						{ type: 'text', text: '；达成率计算参见 ' },
						reference('attainment-equation'),
						{ type: 'text', text: '。复盘结论应附客户与回款明细，便于后续核验。' },
					],
				},
				{
					type: 'typstSource',
					attrs: {
						id: 'source-note',
						source:
							'#text(size: 9pt, fill: gray)[核验负责人：#data.analyst。收入与回款分别核对，未确认的差异不提前归因。]',
					},
				},
				{
					type: 'table',
					attrs: { typstTableStyle: 'borderless' },
					content: [
						row(['行动', '负责人 / 交付'], true),
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
				...styleSamples,
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
		label: '完整示例 · 图表、排版与外部数据',
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

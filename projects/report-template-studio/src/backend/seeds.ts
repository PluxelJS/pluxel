import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
/** Extra files provide the studio's agent instructions without rewriting supplied assets. */
export async function workspaceSeed(
	assetsRoot: string,
	name: string,
	extraFiles: Record<string, string> = {},
) {
	const source = await readFile(join(assetsRoot, 'templates/bank-confirmation.typ'), 'utf8')
	const files: Record<string, Uint8Array> = {}
	const texts: Record<string, string> = {
		'studio.json': JSON.stringify(
			{
				name,
				fonts: ['共享/字体'],
			},
			null,
			2,
		),
		'报表/银行询证函/排版.typ': source
			.replace(
				'#let letter = json("/inputs/header.json")\n#let accounts = json("/inputs/accounts.json")\n#let body = read("/inputs/body.txt")',
				'#let data = json("/inputs/data.json")\n#let letter = data.header\n#let accounts = data.accounts\n#let body = data.body',
			)
			.replace('"financial-correspondence.typ"', '"../../共享/主题/财务函件.typ"'),
		'报表/银行询证函/银行询证函.ts': `import { defineTypstDocument } from '@pluxel/plugin-typst/template'
import * as v from 'valibot'

export default defineTypstDocument({
  template: './排版.typ',
  schema: v.object({
    header: v.optional(v.pipe(v.object({
      bankName: v.optional(v.pipe(v.string(), v.title('银行名称')), '示例银行'),
      companyName: v.optional(v.pipe(v.string(), v.title('被询证单位')), '示例有限公司'),
      sourceName: v.optional(v.pipe(v.string(), v.title('源账套')), '示例账套'),
      asOf: v.optional(v.pipe(v.string(), v.title('余额日期')), '2026-09-30'),
      currency: v.optional(v.pipe(v.string(), v.title('币种')), '人民币'),
      replyTo: v.optional(v.pipe(v.string(), v.title('回函地址及接收人')), '示例市示例路 1 号，财务部'),
    }), v.title('函件信息')), {}),
    accounts: v.optional(v.pipe(v.array(v.object({
      code: v.pipe(v.string(), v.title('科目编码')),
      name: v.pipe(v.string(), v.title('科目名称')),
      bankAccountNumber: v.pipe(v.string(), v.title('银行账号')),
      bookAmountDisplay: v.pipe(v.string(), v.title('账面余额（展示值）')),
    })), v.title('账户明细')), [{ code: '1002.01', name: '银行存款', bankAccountNumber: '示例账号 0001', bookAmountDisplay: '128,600.00' }]),
    body: v.optional(v.pipe(v.string(), v.title('正文')), '为核实本公司银行存款余额，现将下列资料寄送贵行，请予核对。\\n如与贵行记录相符，请在回函确认栏签章；如有差异，请说明差异情况。'),
  }),
})
`,
		'报表/银行账户余额汇总表/银行账户余额汇总表.ts': `import { defineTypstDocument } from '@pluxel/plugin-typst/template'
import * as v from 'valibot'

export default defineTypstDocument({
  template: './排版.typ',
  schema: v.object({
    header: v.optional(v.pipe(v.object({
      companyName: v.optional(v.pipe(v.string(), v.title('公司名称')), '示例有限公司'),
      asOf: v.optional(v.pipe(v.string(), v.title('核对日期')), '2026-09-30'),
      currency: v.optional(v.pipe(v.string(), v.title('币种')), '人民币'),
    }), v.title('报表信息')), {}),
    accounts: v.optional(v.pipe(v.array(v.object({
      code: v.pipe(v.string(), v.title('科目编码')),
      name: v.pipe(v.string(), v.title('科目名称')),
      bankAccountNumber: v.pipe(v.string(), v.title('银行账号')),
      bookAmountDisplay: v.pipe(v.string(), v.title('账面余额（展示值）')),
    })), v.title('账户明细')), [{ code: '1002.01', name: '银行存款', bankAccountNumber: '示例账号 0001', bookAmountDisplay: '128,600.00' }]),
  }),
})
`,
		'报表/银行账户余额汇总表/排版.typ': `#import "../../共享/主题/财务函件.typ": correspondence, statement-table, amount
#let data = json("/inputs/data.json")
#show: correspondence.with(title: [银行账户余额汇总表], numbering: "1 / 1")
#text(weight: "bold")[#data.header.companyName]
#parbreak()
核对日期：#data.header.asOf #h(1fr) 币种：#data.header.currency
#statement-table(
  columns: (1fr, 1.4fr, 1.6fr, 1fr),
  headers: ([科目编码], [科目名称], [银行账号], [账面余额]),
  align: (left, left, left, right),
  ..data.accounts.map(account => (account.code, account.name, account.bankAccountNumber, amount(account.bookAmountDisplay))).flatten(),
)
`,
		'报表/季度经营分析/季度经营分析.ts': `import { defineTypstDocument } from '@pluxel/plugin-typst/template'
import * as v from 'valibot'

export default defineTypstDocument({
  template: './排版.typ',
  schema: v.object({
    company: v.optional(v.pipe(v.string(), v.title('公司名称')), '示例有限公司'),
    period: v.optional(v.pipe(v.string(), v.title('报告期间')), '2026 年第三季度'),
    revenue: v.optional(v.pipe(v.number(), v.minValue(1), v.title('营业收入（元）')), 1286000),
    cost: v.optional(v.pipe(v.number(), v.minValue(0), v.title('营业成本（元）')), 806000),
    fixedCost: v.optional(v.pipe(v.number(), v.minValue(0), v.title('固定成本（元）')), 180000),
    contributionRate: v.optional(v.pipe(v.number(), v.minValue(0.01), v.maxValue(1), v.title('边际贡献率')), 0.4),
    projects: v.optional(v.pipe(v.array(v.object({
      name: v.pipe(v.string(), v.title('项目名称')),
      revenue: v.pipe(v.number(), v.minValue(0), v.title('收入（元）')),
      status: v.pipe(v.string(), v.title('执行情况')),
    })), v.title('项目明细')), Array.from({ length: 36 }, (_, index) => ({
      name: '服务项目 ' + (index + 1),
      revenue: 18000 + index * 1000,
      status: index % 4 === 0 ? '待验收' : '已交付',
    }))),
    conclusion: v.optional(v.pipe(v.string(), v.title('管理建议')), '重点跟进待验收项目回款，控制交付成本，持续观察边际贡献率。'),
  }),
})
`,
		'报表/季度经营分析/排版.typ': `#import "../../共享/主题/财务函件.typ": correspondence, statement-table, note
#let data = json("/inputs/data.json")
#show: correspondence.with(title: [季度经营分析报告], numbering: "1 / 1")
#set page(header: align(right, text(size: 9pt, fill: luma(90), [#data.company · #data.period])))
#let money(value) = str(calc.round(value, digits: 2)) + " 元"
#let margin = calc.round((data.revenue - data.cost) / data.revenue * 100, digits: 1)

= 经营概况
#data.company 在 #data.period 实现营业收入 #money(data.revenue)，营业成本 #money(data.cost)，毛利率 #margin%。
#statement-table(
  columns: (1fr, 1fr), headers: ([经营指标], [金额]), align: (left, right),
  [营业收入], money(data.revenue),
  [营业成本], money(data.cost),
  [毛利], money(data.revenue - data.cost),
)

= 盈利测算
毛利率以收入与成本的差额除以收入计算；盈亏平衡收入以固定成本除以边际贡献率测算。
$ "毛利率" = frac("营业收入" - "营业成本", "营业收入") times 100 % $
$ "盈亏平衡收入" = frac("固定成本", "边际贡献率") $
本期测算盈亏平衡收入为 #money(data.fixedCost / data.contributionRate)。
#note[该示例展示经营测算与排版，计算口径由业务系统负责；正式财务金额应按业务精度规则处理。]

= 收入结构示意
#figure(image("收入结构.svg", width: 85%), caption: [业务收入结构示意（静态图片资产）])
#note[此图是随工作区导出的静态说明图片，表单变更只更新上方指标和下方明细，不改变图片。]

#pagebreak()
= 项目执行明细
下表在跨页时自动重复表头，页眉和页码沿用整份文档。
#statement-table(
  columns: (auto, 1.4fr, 1fr, 1fr), headers: ([序号], [项目名称], [收入], [执行情况]),
  align: (center, left, right, left),
  ..data.projects.enumerate().map(((index, project)) => (str(index + 1), project.name, money(project.revenue), project.status)).flatten(),
)
= 管理建议
#data.conclusion
`,
		'报表/季度经营分析/收入结构.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="200" viewBox="0 0 720 200">
<rect width="720" height="200" rx="12" fill="#f3f6fa"/>
<g font-family="sans-serif" font-size="16" fill="#334155">
<text x="24" y="38">A</text><text x="24" y="94">B</text><text x="24" y="150">C</text>
<rect x="60" y="20" width="500" height="26" rx="4" fill="#2563eb"/>
<rect x="60" y="76" width="300" height="26" rx="4" fill="#0d9488"/>
<rect x="60" y="132" width="200" height="26" rx="4" fill="#d97706"/>
<text x="575" y="39">50%</text><text x="375" y="95">30%</text><text x="275" y="151">20%</text>
</g></svg>`,
		'共享/主题/财务函件.typ': await readFile(
			join(assetsRoot, 'templates/financial-correspondence.typ'),
			'utf8',
		),
		...extraFiles,
	}
	for (const [path, text] of Object.entries(texts)) files[path] = Buffer.from(text)
	for (const fontName of await readdir(join(assetsRoot, 'fonts')))
		files[`共享/字体/${fontName}`] = await readFile(join(assetsRoot, 'fonts', fontName))
	const copyInstructions = async (directory: string, prefix = '') => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name
			if (entry.isDirectory()) await copyInstructions(join(directory, entry.name), path)
			else if (entry.isFile()) files[path] = await readFile(join(directory, entry.name))
			else throw new Error('Unsupported bundled workspace asset')
		}
	}
	await copyInstructions(join(assetsRoot, '..', 'workspace-assets'))
	return files
}

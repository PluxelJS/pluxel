#import "../lib/pluxel.typ" as report
#import "../template/blocks.typ": metrics, revenue-chart
#let sales = json("../data/sales.json")
= 经营分析

// 人和 Agent 修改本文件；保留未涉及的注释与参数。
本季度营收增长，详细原因待补充。#text(fill: red)[*重要事项*]需结合合同验收节奏核实。

本期属于 #upper("q3")，这段未知内联调用保留在原位置。

#metrics(data: json("../data/sales.json"), title: "核心指标")

#figure(revenue-chart(data: json("../data/sales.json")), caption: [季度营收对比，单位：*万元*。品牌见 #report.reference(<fig:brand>, caption: true)。本图见 #report.reference(<fig:revenue>, caption: true)。]) <fig:revenue>

#table(columns: (1fr, 1fr),
  table.header([渠道], [营收（万元）]),
  [直销], [75],
  [合作伙伴], [45],
)

#table(columns: (1fr, 1fr), stroke: none,
  table.header(table.cell(colspan: 2)[补充口径（保留合并结构）]),
  [收入确认

按已验收合同统计。], [不含税],
)

// 未求值为静态正文：复杂源码块仍属于原始 Typst。
#for name in ("渠道归因", "续约原因") [待验证：#name。#linebreak()]

#figure(image("../assets/brand.svg", width: 50pt), caption: [报告品牌标记，营收见 @fig:revenue。]) <fig:brand>

品牌标记见 @fig:brand。

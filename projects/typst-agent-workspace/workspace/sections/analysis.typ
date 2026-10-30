#import "../lib/pluxel.typ" as report
#import "../template/blocks.typ": metrics

#report.field(json("../data/sales.json"), ("company",)) · #report.field(json("../data/sales.json"), ("quarter",))

本季度营收为 *120 万元*，较上季度的 100 万元增加 20 万元，环比增长 *20%*。直销贡献 75 万元，占总营收的 *62.5%*；合作伙伴贡献 45 万元，占 *37.5%*。续约率为 *91%*。

现有数据能说明营收变化与本季度渠道构成，但不足以判断增长来自新增客户、续约扩容还是价格变化。续约率也缺少上期对照与统计口径；这些原因和趋势需要补充材料验证。

#table(columns: (1fr, 1fr, 1fr),
  table.header([渠道], [营收（万元）], [占比]),
  [直销], [75], [62.5%],
  [合作伙伴], [45], [37.5%],
)

#metrics(data: json("../data/sales.json"), title: "季度经营指标")

#table(columns: (1fr, 1fr), stroke: none,
  table.hline(y: 0, stroke: 1pt + black),
  table.header(table.cell(colspan: 2)[补充口径（保留合并结构）]),
  table.hline(y: 1, stroke: .5pt + black),
  [收入确认

按已验收合同统计。], [不含税],
  table.hline(y: 2, stroke: 1pt + black),
)


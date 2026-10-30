// 数据只从调用方传入；正文不复制计算后的值。
#let metrics(data: none, title: "核心指标") = block(fill: rgb("eef4fa"), inset: 10pt, width: 100%)[
  *#title* #linebreak()
  营收：#data.revenue 万元；上期：#data.previousRevenue 万元；
  增长率：#calc.round((data.revenue / data.previousRevenue - 1) * 100, digits: 1)%；
  续约率：#data.renewalRate%。
]

#let revenue-chart(data: none) = {
  let maximum = calc.max(data.revenue, data.previousRevenue)
  grid(columns: (50pt, 1fr, 45pt), gutter: 8pt,
    [上期], rect(width: 200pt * data.previousRevenue / maximum, height: 16pt, fill: rgb("a8bdd4"), stroke: none), [#data.previousRevenue],
    [本期], rect(width: 200pt * data.revenue / maximum, height: 16pt, fill: rgb("3267a8"), stroke: none), [#data.revenue],
  )
}

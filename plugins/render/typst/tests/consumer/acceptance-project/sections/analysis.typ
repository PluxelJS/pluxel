= 接收方验收

初始中文正文，保留 *重要事项* 和未知表达式 #upper("q3")。

#let sales = json("../data/sales.json")
#figure(
  stack(dir: ttb, spacing: 6pt, ..sales.channels.map(channel => [
    #channel.name #rect(width: channel.actual * 1pt, height: 10pt, fill: blue)
    营收 #channel.actual
  ])),
  caption: [渠道 *营收*，核对 @fig:revenue。],
  supplement: [图],
) <fig:revenue>

#table(columns: 2, [项目], [金额], [合计], [#sales.total])

#import "../lib/pluxel.typ" as pluxelInserted2

#import "../template/cards.typ" as pluxelInserted

#import "../lib/pluxel.typ" as report
= 行动核对

跨文件引用 @fig:income，并保留完整的行动说明。#pluxelInserted2.field(json("../data/sales.json"), ("total",))

#pluxelInserted.metrics(data: json("../data/sales.json"), title: "浏览器插入指标")

#report.latex("x^2", block: true) <eq:model>

公式 @eq:model。

#for n in (1, 2) [未知源码仍然保留：#n。]

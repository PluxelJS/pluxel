#import "lib/pluxel.typ" as report
#import "components/blocks.typ": metrics
#show: report.document
#set page(paper: "a4", margin: 18mm)
#set text(font: "Noto Serif CJK SC", size: 10.5pt, lang: "zh")
#set heading(numbering: "1.")
#set figure(numbering: "1")
#set math.equation(numbering: "(1)")
#align(center)[#text(size: 22pt, weight: "bold")[#report.field(json("data/sales.json"), ("company",))季度经营报告]]
#align(center)[#report.field(json("data/sales.json"), ("quarter",)) · 经营简报]

// 固定区域归文档模板所有；与正文组件使用同一份业务数据。
#metrics(data: json("data/sales.json"), title: "季度概览")

#include "sections/analysis.typ"
#include "sections/actions.typ"

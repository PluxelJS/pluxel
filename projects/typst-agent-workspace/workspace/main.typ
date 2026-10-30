#import "lib/pluxel.typ" as report
#show: report.document
#set page(paper: "a4", margin: 22mm, numbering: "1")
#set text(font: "Noto Serif CJK SC", size: 10.5pt, lang: "zh")
#set par(justify: true, leading: 0.7em)
#set heading(numbering: "1.")
#set figure(numbering: "1")
#show figure.where(kind: image): set figure(supplement: [图])

#align(center)[#text(size: 22pt, weight: "bold")[季度经营报告]]
#v(12pt)
= 经营分析
#include "sections/analysis.typ"
= 行动建议
#include "sections/actions.typ"

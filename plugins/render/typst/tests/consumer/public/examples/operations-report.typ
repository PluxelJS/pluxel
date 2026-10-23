#let data = json("/inputs/editor/data.json")
#set page(paper: "a4", margin: 32pt,
  header: align(right, text(size: 8pt, fill: rgb("#587064"))[#data.company · #data.period]),
  footer: text(size: 8pt, fill: rgb("#587064"))[模板负责图表与统计口径 · #data.analyst #h(1fr) #context counter(page).display("1 / 1", both: true)])
#set text(font: "Noto Serif CJK SC", size: 10pt)
#set par(leading: .7em)
#set heading(numbering: none)
#let green = rgb("#28745c")
#text(size: 9pt, fill: green)[OPERATIONS / REVIEW]
#v(2pt)
#text(size: 24pt, weight: "bold")[渠道经营报告]
#parbreak()
#data.company #h(1fr) #data.period
#v(10pt)
#include "_editor/regions/body.typ"

= 后续行动
#include "_editor/regions/notes.typ"

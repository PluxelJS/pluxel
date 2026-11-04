#import "lib/pluxel.typ" as report
#set page("a4", margin: 15mm)
#set text(font: "Noto Serif CJK SC", size: 10pt, lang: "zh")

#let application = json("data/application.json")
#assert(application.applicationType in ("new", "renew", "change"),
  message: "applicationType 必须是 new、renew 或 change。")
#let choice(label, value) = [
  #box(width: 3mm, height: 3mm, stroke: 0.6pt, inset: 0pt)[
    #if application.applicationType == value {
      place(top + left)[
        #curve(
          stroke: 0.6pt,
          curve.move((0.5mm, 1.4mm)),
          curve.line((1.2mm, 2.1mm)),
          curve.line((2.5mm, 0.6mm)),
        )
      ]
    }
  ]
  #h(1mm)
  #label
]

// 保留填写留白；内容超过最小高度时自然分页，不缩字或截断。
#let form-cell(value, min-height) = table.cell(colspan: 3)[
  #context {
    // 跨三列共 155mm，减去左右各 2.5mm 的单元格内边距。
    let required = measure(block(width: 150mm, value)).height
    block(height: if required > min-height { auto } else { min-height }, value)
  }
]

#align(center)[
  #text(size: 16pt, weight: "bold")[项目申请审批表]
]
#v(5mm)
#table(
  columns: (25mm, 1fr, 25mm, 1fr),
  rows: (auto, auto, auto, auto, auto),
  stroke: 0.6pt,
  inset: 2.5mm,
  [姓名], [#report.field(json("data/application.json"), ("name",))],
  [学号], [#report.field(json("data/application.json"), ("studentId",))],
  [申请类型], table.cell(colspan: 3)[
    #choice([新申请], "new") #h(5mm)
    #choice([续期], "renew") #h(5mm)
    #choice([变更], "change")
  ],
  [申请理由], form-cell(report.field(json("data/application.json"), ("reason",)), 130mm),
  [审批意见], form-cell(report.field(json("data/application.json"), ("opinion",)), 85mm),
  [申请人签字], table.cell(colspan: 3)[
    #report.field(json("data/application.json"), ("signature",))
    #h(1fr)
    日期：#report.field(json("data/application.json"), ("date",))
  ],
)

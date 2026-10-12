// Financial correspondence theme for Chinese business / audit letters.
// Adapted from the supplied financial-correspondence template. Amounts are formatted by the application.
// This is a business theme, not a GB/T 9704 official-document template.


// Page and typography only. The business template owns the actual content.
#let correspondence(title: none, numbering: none, body) = {
  set document(title: title)
  set page(
    paper: "a4",
    margin: (top: 24mm, bottom: 22mm, left: 25mm, right: 23mm),
    numbering: numbering,
    number-align: center + bottom,
  )
  set text(
    font: ("Liberation Serif", "Noto Serif CJK SC"),
    fallback: false,
    size: 11pt,
    lang: "zh",
    region: "CN",
    number-type: "lining",
  )
  set par(justify: true, leading: 0.65em, spacing: 0.8em)
  // Math needs both the compiler's bundled math font and our portable Chinese font.
  show math.equation: set text(font: ("New Computer Modern Math", "Noto Serif CJK SC"))
  set figure.caption(position: bottom)
  show heading.where(level: 1): set text(size: 11pt, weight: "bold")
  show heading.where(level: 1): set block(above: 9pt, below: 4pt)

  if title != none {
    block(width: 100%, above: 0pt, below: 9mm, sticky: true)[
      #align(center, text(size: 16pt, weight: "bold", title))
    ]
  }
  body
}

// Indentation belongs to prose, never to titles, recipients or table cells.
#let prose(body) = {
  set par(
    justify: true,
    first-line-indent: (amount: 2em, all: true),
  )
  body
}

#let section(title) = heading(level: 1, numbering: none, title)

// The application supplies exact, rounded, grouped display strings, including unknown labels.
// Keep financial arithmetic and formatting policy in its existing owner.
#let amount(value) = box(text(number-width: "tabular", value))

// Three-rule table: no vertical borders, header repeats over page breaks.
// Columns and alignments belong to the individual data table.
#let statement-table(
  columns: (1fr, auto),
  headers: (),
  align: left,
  title: none,
  unit: none,
  ..cells,
) = {
  if title != none or unit != none {
    block(sticky: true, above: 7pt, below: 4pt)[
      #grid(
        columns: (1fr, auto),
        align: (left, right),
        if title == none { [] } else { text(size: 10pt, weight: "bold", title) },
        if unit == none { [] } else { text(size: 9pt, [单位：#unit]) },
      )
    ]
  }

  {
    set text(size: 9.5pt)
    set par(justify: false, leading: 0.4em, spacing: 0pt, first-line-indent: 0pt)
    table(
      columns: columns,
      align: align,
      stroke: none,
      inset: (x: 5pt, y: 4.5pt),
      table.header(
        table.hline(stroke: 0.85pt),
        ..headers.map(header => strong(header)),
        table.hline(stroke: 0.45pt),
      ),
      ..cells.pos(),
      table.hline(stroke: 0.85pt),
    )
  }
}

// Ruled grids are for response fields and confirmations, NOT for amounts.
#let form-table(columns: (1fr, 1fr), ..cells) = {
  set text(size: 10pt)
  set par(justify: false, spacing: 0pt, first-line-indent: 0pt)
  table(
    columns: columns,
    stroke: 0.4pt + luma(90),
    inset: (x: 6pt, y: 6pt),
    ..cells.pos(),
  )
}

#let note(body) = block(above: 5pt, below: 0pt)[
  #set text(size: 9pt, fill: luma(65))
  #body
]

// Keep the signatory and date together on the same page.
#let sign-off(issuer, date) = block(
  above: 11mm,
  breakable: false,
  align(right, [#issuer \
  #date]),
)

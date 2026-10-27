/** Shared Typst runtime. State follows layout order across includes, not lexical variable capture. */
export const referenceSource = String.raw`#let reference-caption = state("pluxel-reference-caption", false)

#let is-editor-reference(it) = type(it.value) == dictionary and it.value.at("__pluxel_reference", default: false) == true
#let short-reference(it) = if is-editor-reference(it) { ref(it.value.target) } else { it }

#let render-reference(it) = if is-editor-reference(it) { context {
  let args = it.value
  let enabled = if args.show-caption == auto { reference-caption.get() } else { args.show-caption }
  ref(args.target)
  if enabled {
    let target = query(args.target).first(default: none)
    let caption = if target != none and target.func() == figure and target.caption != none {
      target.caption.body
    } else { none }
    if caption != none and caption != [] {
      [ 「#link(target.location())[#show metadata: short-reference
      #caption]」]
    }
  }
}} else { it }
`

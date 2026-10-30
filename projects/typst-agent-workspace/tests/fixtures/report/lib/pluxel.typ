#let reference-caption = state("pluxel-reference-caption", false)

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

#import "mitex/mitex.typ": mi, mitex

// Install once in the root template with #show: report.document.
#let document(body) = {
  show metadata: render-reference
  body
}

#let latex(source, block: false) = math.equation(
  block: block,
  if block { mitex(source).body } else { mi(source).body },
)

#let reference(target, caption: auto) = metadata((
  __pluxel_reference: true,
  target: target,
  show-caption: caption,
))

#let field(data, path) = {
  let value = data
  for key in path {
    if type(value) == array {
      if key == "length" { value = value.len() }
      else { value = value.at(if type(key) == int { key } else { int(key) }) }
    } else { value = value.at(str(key)) }
  }
  str(value)
}

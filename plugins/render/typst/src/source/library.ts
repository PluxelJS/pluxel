import { referenceSource } from '../tiptap/reference-source.js'

/** Identifiable ordinary Typst source, copied into the user's project and owned there. */
export const typstSourceLibrary = `${referenceSource}
${String.raw`#import "mitex/mitex.typ": mi, mitex

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
`}`

/** Files are authored project inputs; no runtime-generated body or network package resolver. */
export async function createTypstSourceLibrary(): Promise<Record<string, string>> {
	const { createMiTeXFiles } = await import('../tiptap/mitex.js')
	const files: Record<string, string> = { 'lib/pluxel.typ': typstSourceLibrary }
	for (const [path, source] of Object.entries(createMiTeXFiles()))
		files[path.replace(/^_editor\/mitex\//, 'lib/mitex/')] = source
	return files
}

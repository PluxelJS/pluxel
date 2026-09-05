# Takumi Markdown Typst Math Plugin 设计

TypstMathPlugin has exactly one business surface: createMarkdownExtension() returns a
trusted MarkdownExtension for TakumiMarkdownPlugin. It is a required consumer of Markdown,
not a generic document compiler, font provider, renderer adapter or file/network capability.

## execution path

~~~text
accepted Takumi reservation
  -> Satteri parses Markdown math node
  -> Typst extension validates formula
  -> Runtime shared Worker compiles fixed Typst wrapper to cloneable SVG bytes
  -> Markdown asset sink copies bytes under its render budget
  -> one final Takumi image/SVG render
~~~

The Worker declaration is module-level and uses defineWorkerTask(); no Plugin creates an
independent worker pool. The Worker only receives formula text and fixed scalar limits. The final
Takumi renderer is never dispatched into that Worker, avoiding a nested renderer and a worker
waiting on an unrelated libuv native slot.

## restricted formula contract

The validator accepts a small math-expression character grammar before creating a compiler. It
rejects #, quoted strings, backslash escapes, paths and resource/dynamic identifiers including
import, include, read, sys, image, raw, eval and plugin. A fixed wrapper supplies page size,
margin and text size; caller input cannot select package/font/path, network, input data or
arbitrary Typst document options.

This validation is deliberately not presented as a security sandbox for native code. Worker
isolation protects the host JavaScript event loop and unifies task admission; native crashes and
resource use remain process risks. Formula count/characters/SVG bytes and Markdown asset/Takumi
limits bound the product contract.

## lifecycle and failure

The generated extension is bound to its caller generation through effects. Manual/owner close,
provider replacement and Markdown cancellation all abort pending Worker work and await its
settlement. Worker response failures become stable TypstMathError codes; the Markdown layer
preserves them instead of replacing them with a generic extension failure.

The worker creates a compiler per job, emits only SVG bytes, and makes cleanup best-effort without
overwriting a successful result with a cleanup error. Direct formula/worker tests, Runtime-host
unsafe-formula coverage and a dynamic Runtime artifact smoke test protect this boundary.

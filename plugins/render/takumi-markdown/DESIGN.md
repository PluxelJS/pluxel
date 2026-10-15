# Markdown conversion for Takumi

`TakumiMarkdownPlugin` owns GFM conversion, static Rangi highlighting, trusted Satteri
extensions and optional restricted Typst mathematics. A renderer converts Markdown once and
passes HTML and generated images to one `TakumiPlugin.renderInWorker` or `renderSvgInWorker`
call. Its options extend cloneable Takumi Worker options with a document theme. Concrete font
bytes, CSS, image sources and encoding fields retain their native meanings; there is no second
queue or reservation.

`createRenderer()` snapshots the extension list, available mathematics provider and default
theme. Its handle belongs to the dependency caller generation. Explicit close, caller stop and
provider stop abort preparation and await pending work. Standard `AbortSignal.any()` links
these lifetimes with per-call cancellation. Cleanup does not promise preemption of synchronous
parser or native work. The final Takumi task uses execution settlement.

The document layer limits its own source, AST, highlighted code, generated HTML, formulas and
extension assets. Large string walks and asset copies yield cooperatively. GFM, Rangi and
trusted extension code stay in the caller realm; final HTML/CSS preparation and rendering run
in the shared Worker. Markdown HTML is disabled and raw HAST nodes are removed after
extensions. Remote image loading requires explicit `images.allowRemote: true`; preloaded
images work without network access. Fetch callbacks, Renderer instances and WASM modules do
not cross the Worker boundary.

Extensions are trusted application code. Their factories and AST phases run in declaration
order, and their exceptions propagate unchanged. Each factory receives the resolved per-render
theme through `MarkdownExtensionContext.theme`. An asset sink copies bytes into this render's
opaque namespace and rejects use after the render settles. Caller image options are preserved
when adding those generated sources.

Typst is a type-only optional Plugin ref and optional peer, not a second required Plugin or
compiler package. Without a running provider, documents use ordinary Markdown. Provider
appearance, withdrawal or replacement restarts Markdown and downstream consumers; old renderer
handles cannot silently switch provider. When selected, the built-in mathematics pipeline adds
restricted formula/SVG limits from `TakumiMarkdownConfig.math`, delegates stateless SVG
compilation to TypstPlugin, and contributes its SVG bytes to the same asset sink. Typst owns
fonts, native compilation and its Worker execution. Each formula task settles before the final
Takumi task is submitted, so a shared slot never waits for nested shared Worker admission.

Formula SVGs have transparent backgrounds and use the same theme foreground palette as the
document stylesheet. Inline and display formulas preserve their compilation modes; SVG
viewBox dimensions in points become explicit CSS-pixel image dimensions at 96/72 scale.

`MarkdownError` describes document failures and classified formula/Typst compile or byte-limit
failures, preserving the original cause for mapped failures. Unknown extension, provider and
Worker failures retain their own contracts. Error names are not used to guess which extension
owns an exception.

Verification covers real Plugin ownership, Worker formats/CSS, GFM/highlighting, generated
assets, limits, raw HTML removal, image IO policy, original extension failures, and Typst
absence/appearance/replacement with actual SVG output. Public usage lives in the
[Markdown guide](../../../docs/plugins/rendering/takumi-markdown.md).

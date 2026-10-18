---
packages:
  '@pluxel/plugin-takumi': major
  '@pluxel/plugin-takumi-markdown': major
---

# Simplify Takumi and consolidate Markdown rendering

TakumiPlugin exposes the upstream `render(input, options)`, `renderSvg(input, options)` and
`renderAnimation(options)` methods with their original return values and errors. Remove the old
provider envelopes, configuration, font policy, Workbench integration, reservation API and scheduler.

Add explicit `renderInWorker`, `renderSvgInWorker` and `renderAnimationInWorker` methods for
cloneable HTML/node data, and `@pluxel/plugin-takumi/worker` for business task JSX and HeroUI. Reuse the
existing shared Workers service; parsing, component execution and native input conversion stay
in the Worker. Independently bundled tasks share a bounded native resource cache per Worker,
isolated by backend constructor and ordered font contents/metadata. React resolvers stay local
to each task bundle, and retained font bytes belong to the cache.

Markdown renderer handles retain GFM conversion, static highlighting, document limits and trusted
extensions. `render(source, options)` and `renderSvg(source, options)` now use cloneable Takumi Worker
options and return bytes/string directly. Install the shared Workers and NodeModules services.
Use `images.allowRemote: true` to enable remote assets; preloaded assets remain the default.

Merge the Typst math extension into Markdown and remove `@pluxel/takumi-markdown-typst`. A running
optional TypstPlugin enables inline/display math automatically. Formula limits live in
`TakumiMarkdownConfig.math`, and formula errors use `MarkdownError`. Compilation and fonts still
belong to TypstPlugin's stateless SVG API; the native Typst package remains workspace-only.
The reference host combines all six rendering engines, including Worker HeroUI cards and Markdown
with Typst formulas, in one ReportStudio business plugin.

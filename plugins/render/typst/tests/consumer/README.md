# Independent Typst consumer

This consumer exercises the built public editor, preview and native compiler without Studio, Monaco or Electron. The [public editor guide](../../../../../docs/plugins/rendering/typst-editor.md) owns the data, Markdown and extension contracts; this page owns the demo workflow and checks.

## Interactive browser playground

From the workspace root:

```sh
mise exec -- vp run @pluxel/plugin-typst#compile
mise exec -- vp run typst
```

Use the URL printed by the managed service and add `/?example=operations-report`. Check `pluxel dev status --profile typst` before operating an existing service; the registered service is `pluxel/typst`. `dev:consumer` is the foreground Vite entry. The consumer uses built public entries: rebuild the plugin after changing those components, while page changes use normal Vite HMR. Package test caches are separate from the open playground's dependency cache.

The layout has two panes:

- Left: **正文 / 数据**, with a separate native Editor and history for each body region.
- Right: **Typst 预览 / 原始 Typst / Markdown**. “原始 Typst” edits the outer template. Markdown follows the current region or selected complete blocks until an edit is captured.
- On phones: **编辑 / 预览** switches panes. Hidden panes and tabs remain mounted, preserving their editors and history.

The template controls the page, fixed clauses, chapter composition, indentation and spacing. It includes generated region files with native Typst `#include`. Body JSON remains authoritative; Markdown is an editable projection, and generated `.typ` files are compiler inputs. There is no Markdown disk mirror or arbitrary Typst-to-Tiptap conversion.

## External data and chart-report example

Choose **图表报告 · 外部数据与模板**. The report combines a logical image, a channel chart component, analysis with styled tables, an action region, LaTeX math, captions and cross-region references. The template component contains KPI cards and a native Typst actual/target bar chart beside its data table. Chart logic and input validation belong to the consumer; its instance belongs to the same body JSON as nearby prose.

The [JSON sample](./public/examples/operations-report.json), [outer template](./public/examples/operations-report.typ) and [cover SVG](./public/examples/operations-cover.svg) are importable assets. [report-example.mjs](./report-example.mjs) accepts a company, period, analyst and one to eight channels with nonnegative actual/target values. Imported templates and registered components must agree with this schema. Logical images map to explicit `/inputs/` resources; template import does not add arbitrary filesystem or network access.

Use these paths to compare the three representations:

1. Change font, size, text/background color or paragraph alignment in the body. The live Markdown preserves overrides; clearing an override restores template inheritance. Templates own line spacing, paragraph spacing, first-line indentation and page layout.
2. Select an image, table or component and add a caption. Edit its caption directly, then edit the separate label in object settings. The body object retains its id when the label changes. A table inside a captioned object remains editable through TableKit.
3. Insert inline or independent math through **插入** or `/`. Click its KaTeX view to edit LaTeX; independent equations also expose label. The final preview uses the same source through the pinned MiTeX runtime. Compare both outputs when using a new macro.
4. Type `@` to find a figure, table or equation from either region by label, title/source, type or region. Enter inserts a structured reference; its editing view shows `@label`, while Typst supplies the actual number. Deleting a target or clearing its label leaves a visible unresolved reference and prevents successful generation until repaired.
5. Open **Markdown**, choose a region or **当前选中块**, then **编辑这份 Markdown**. Review with **查看修改预览**, then **接纳候选**. This updates the native document in one undo step and refreshes the preview. **放弃候选修改** or acceptance returns to live Markdown in the same tab. This manual agent-format editor does not call an LLM.
6. Change external JSON under **数据**, then apply it. Bound fields and charts update while body JSON and undo history remain. Edit/import the outer `.typ` under **原始 Typst** to change template design.

Capturing Markdown fixes the target, native range and revision. Later body, data or template changes make that candidate stale. Editing the candidate invalidates its prepared review, but does not refresh the captured revision. Range capture expands to complete sibling blocks; a paragraph inside one cell or notice can be edited independently, while a selection spanning cells covers the table. Agent format retains styles, captions, equation identity, references and local native subtrees. Ordinary Markdown retains its separate loss checks; `typst` code fences remain literal examples.

The example explicitly installs `TypstTableStyle`, `TypstTemplateBlock` and `TypstSource`. The basic editor factory does not silently install these optional capabilities. The Typst extension factory includes fields, figures/captions, official Mathematics nodes and references. See [optional blocks](../../../../../docs/plugins/rendering/typst-editor.md#可选模板组件与源码块) for installation and removal: removing an extension requires explicit conversion of saved nodes, not silent data deletion.

Select a channel component to edit its instance title in **渠道组件参数**. Confirming applies the existing validator and one transaction; cancel leaves the document unchanged. Unapplied titles remain attached to their instance when changing selection or regions. **参数与数据** displays current parameters/bound data without writing data into the document. The source block's **编辑 Typst 源码 → 应用组件修改** applies a local source draft once. Raw source follows the host compiler's policy and is not a separate sandbox.

## Editing, persistence and navigation

The shared toolbar owns typography, alignment, marks, list indentation, links and insertion. Right-click, Shift+F10/the menu key and **格式** open the same explicit panel; selecting text alone does not open a bubble. Mixed selections show mixed values. **模板字体 / 模板字号 / 模板对齐** remove overrides without inventing a concrete template default. Host font choices do not install browser fonts; the native preview/PDF is the final rendering.

Tables retain official resize, row/column, cell selection, merge and split operations. The table form accepts 1–50 rows and 1–20 columns, with optional leading header. Appearance offers inherited template, grid, grid without side borders, three-line and borderless styles. Three-line does not create a missing header; merged cells preserve their true grid boundaries. Static HTML does not carry editor decorations or final pagination.

Block actions use a fixed native target, with local insertion, conversion, duplication, deletion, move buttons and drag handles. Figure/equation copying assigns fresh identity; moving preserves identity. Ordinary links use **Mod+K** and the shared URL policy. Inputs, source editors, read-only content and IME composition retain their appropriate native behavior. Full details and limits remain in the [editor guide](../../../../../docs/plugins/rendering/typst-editor.md).

Ordinary clicks navigate between rendered content and its source; dragging or modified clicks do not. Body characters and nested cells use native spans; fields/formulas/objects have atom or object-level fallbacks. Fixed text opens the template tab, generated content opens the matching body region, and source-block navigation preserves unapplied local edits. Only coordinates from the current matching snapshot are actionable.

Invalid input leaves admitted data and body unchanged. A template compilation error retains the editable source and old preview, marks it stale and prevents current PDF export. Diagnostics preserve severity, path, range and their own request mapping; late responses cannot replace a newer preview. Successful warnings remain visible. The HTTP adapter distinguishes Typst, Worker, IO, cancellation and unexpected failures.

Save/Reopen retains the example, raw data, body JSON and template in one browser-local slot. Saved status is independent of compilation. Only successful localStorage persistence advances the saved baseline. Pending Markdown, component/source/formula/label inputs participate in save/leave guards; apply or discard them first. Switching examples or reopening asks before replacing changed content, and cancellation preserves the current editors. `beforeunload` depends on platform/user activation and cannot guarantee recovery after a crash.

`vite.config.ts` owns a local HTTP adapter around the native Typst/Fonts plugins, with one session per page. It validates drafts, generates regions and exports the same compiled PDF. Page close releases its session; Vite shutdown releases remaining sessions and temporary templates. This adapter is local test infrastructure, not a new public backend SDK.

## Focused checks

With the existing Playwright service at `ws://127.0.0.1:3000`, run:

```sh
mise exec -- node plugins/render/typst/tests/consumer/view-tabs-check.mjs
```

This connects to the existing browser and app, checks the pane/tab, candidate, data/template and mobile paths, and writes screenshot evidence. `PLAYWRIGHT_WS_ENDPOINT` and `PLUXEL_TYPST_URL` override the endpoints. It starts neither service. Agent-driven visual verification must use the configured shared browser; do not install or launch another browser to bypass that boundary.

Existing focused drivers under this directory cover the following workflows. A driver being listed is not a claim that it has passed against every subsequent change; inspect its browser setup and actual result before reporting it.

| Driver                                                           | Workflow                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `document-check.mjs`                                             | Caption editing/exit, label apply/discard, LaTeX, cross-region `@`, Markdown round trips, copy/cut, undo and responsive bounds |
| `document-clipboard-check.mjs`                                   | Real browser HTML admission for figures, captions, math and references; rejects malformed or unregistered structures           |
| `report-example-check.mjs`, `refactor-cases.mjs`                 | External inputs, data-only changes, draft replacement, failure/recovery, late responses, current PDF and mobile panes          |
| `blocks-check.mjs`, `block-actions-check.mjs`                    | Component/source and ordinary-block operations, selected-block Markdown, native drag, undo and navigation                      |
| `format-check.mjs`, `toolbar-check.mjs`, `link-format-check.mjs` | Explicit formatting, typography, mixed values, links, caret formats, selection, readonly/IME and narrow layouts                |
| `insertion-check.mjs`, `table-tools-check.mjs`                   | Shared insertion catalogs, fixed targets, table dimensions/actions, validation, keyboard and touch                             |
| `table-style.mjs`, `contexts-check.mjs`                          | Table styles, merged boundaries, context menus, HTML re-entry and current PDF                                                  |
| `react-lifecycle-check.mjs`                                      | Public React content/data/key lifecycle and unmount; uses `/react-lifecycle.html` without native sessions                      |

Browser checks must close only their own client sessions. The session-close endpoint is awaited before browser teardown so keepalive timing cannot exhaust the running app's session capacity.

The package's `tests/tiptap-document.test.ts` exercises document semantics and real native cross-file output. `tests/mitex.test.ts` exercises the fixed runtime in native PDF/Vector and browser WASM SVG, including template numbering, cross-file references and error recovery. The latter requires Fontconfig and DejaVu Math TeX Gyre on the host and explicitly supplies that font to both compilers.

## Isolated package acceptance

Build the package, then run:

```sh
mise exec -- vp run @pluxel/plugin-typst#compile
mise exec -- node plugins/render/typst/tests/consumer.mjs
```

The acceptance fixture copies actual `dist` and native compiler bytes into an external temporary directory, expands workspace/catalog dependency protocols and applies `publishConfig.exports` in staged manifests. The package is private and has no version; the fixture does not invent a tarball version, mutate repository versions or import workspace source into the external app.

A separate native checker installs the root's Core/Fonts/services/Workbench/capnweb server peers and verifies strict declarations plus Node import without Tiptap or React. The external browser app then checks three stages:

1. Typst and valibot only: `/template`, `/browser`, strict declarations and production browser imports.
2. Tiptap peers without React: `/tiptap`, Markdown conversion and generation in Node without a DOM.
3. React peers: the public guide's complete React example, UI and public stylesheet build, and real browser/native preview/PDF workflows.

Peers are explicitly installed with `npm --legacy-peer-deps --ignore-scripts`; this validates built entry isolation, not registry publication or every package manager's automatic peer resolution. The [public guide](../../../../../docs/plugins/rendering/typst-editor.md#入口与安装) owns the dependency list. Browser bundles must not import Core, services or the native compiler. The fixture's native backend uses the same public session API as an ordinary consumer.

The native fixture resolves Noto Serif CJK SC and Liberation Serif through Fontconfig, copies their original bytes and registers them through Fonts before opening the session. It allows 32 MiB per font for the installed Noto TTC; Typst diagnostics and rendered output verify actual selected faces. Registrations are disposed after the session. The fixture requires network for staged npm installs and an available Chromium runtime; it does not validate Studio desktop lifecycle or platform portability.

The output directory is normally `$TMPDIR/pluxel-typst-consumer-*`; `PLUXEL_TYPST_CONSUMER_OUTPUT` selects a new external directory. It contains the standalone app, native checker, staged artifacts and evidence: check/install logs, module lists, native metrics, Markdown/HTML results, JSON draft, PDF/PNG and screenshots. Studio has separate runtime and desktop acceptance paths.

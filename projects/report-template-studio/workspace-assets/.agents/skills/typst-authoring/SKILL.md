---
name: typst-authoring
description: Edit Typst templates, Valibot input contracts and Tiptap-backed body regions in Studio, preserving captions, LaTeX formulas, labels and cross-file references, then verify the compiled pages.
---

# Work from the document contract

Read `studio.json`, the affected same-name `.ts` report entry, its `template` `.typ` source, and imported shared theme before editing. Use the file tools to inspect only the relevant directories. `@folder` in the user's request identifies context to inspect, not a request to rewrite every file there.

A report is discovered by the naming convention `folder/folder.ts`, including nested folders. The entry must default-export `defineTypstDocument({ template, schema, createFiles? })` imported from `@pluxel/plugin-typst/template`. The entry filename supplies its name; do not declare a separate name. `createFiles` is synchronous. `template` is a `.typ` path relative to the entry directory and must resolve inside the workspace. Ordinary `.typ` files are source/modules, not standalone preview entries. No document list is stored in studio.json. Filename discovery keeps broken entries visible for repair. Keep shared typography, page setup, and table styles in reusable `.typ` functions; use relative imports such as `../../共享/主题/财务函件.typ`. Font directories are listed in `studio.json`; use the font's actual family name and preserve bundled licenses.

# Form defaults and input data

The same-name TypeScript entry defines its `schema` using `valibot` inside the document definition. Use native Valibot `v.title` and `v.description` for labels and descriptions; reserve `valibot-form` metadata for Studio-specific controls. Keep the schema inline in the definition unless another document actually reuses it. A typical report needs only its same-name `.ts` entry and `排版.typ`. Put demonstration values in Valibot defaults rather than duplicating a separate example-data object:

```ts
import * as v from 'valibot'
import { defineTypstDocument } from '@pluxel/plugin-typst/template'

export default defineTypstDocument({
	template: './排版.typ',
	schema: v.object({
		title: v.pipe(v.optional(v.string(), '月度报表'), v.title('报表标题')),
		rows: v.optional(
			v.array(
				v.object({
					item: v.pipe(v.string(), v.title('项目')),
					amount: v.pipe(v.number(), v.title('金额')),
				}),
			),
			[{ item: '服务收入', amount: 128600 }],
		),
	}),
})
```

The schema is the document data contract, independent of input UI. API, database and batch callers can use the same definition without a form renderer. Use defaults for meaningful omissions or demonstration values; keep critical production inputs required so missing data fails validation.

Studio recursively combines `v.getDefaults(schema)` with external caller input, preserving explicit empty strings, zero, false and null. Supplied arrays determine length and items; each supplied item recursively fills missing keys from the same default index, without appending default tail items. Empty arrays remain empty, then validates with `safeParse`. Do not generate default data.json files or put form values into the workspace. Studio persists user input outside the workspace; another host supplies its business data directly. Only genuine source and static assets travel with templates. Without `createFiles`, validated input is exposed as `/inputs/data.json` in the compilation virtual filesystem, without writing a real file. A custom synchronous `createFiles(data)` returns a file map whose keys are under `/inputs/`, with `{ kind: 'json', value }` or `{ kind: 'text', text }` values. Do not perform I/O or install runtime packages in schema modules.

An optional same-name `<name>.editor.json` explicitly declares editable regions, bindable schema output fields and initial Tiptap documents. Tiptap JSON remains the body authority; one region is one independently editable piece of prose, not a separately persisted Markdown file. It does not extend `defineTypstDocument` or the runtime module whitelist. Keep fixed clauses in the template and include generated `_editor/regions/<regionId>.typ` sources from the workspace root. `_editor/` and `/inputs/editor/` are reserved; user source and `createFiles` collisions fail. The editor reads parsed data from `/inputs/editor/data.json`; raw input and complete region JSON remain one versioned application draft outside the exported workspace. A template revision change requires explicit draft adoption, never silent reset or repair.

# Edit current body prose

Use `read_body({ entry, regionId? })` to discover editable regions and read their current Agent Markdown, including unsaved changes in the desktop. Keep the returned `baseRevision`; it binds the full raw data, all regions and template source. Edit only the requested content. Common text uses Markdown; `textStyle` and `dataField` shortcodes carry styles and fields, `:::attrs` carries one block's properties, `:::figure` and nested `:::caption` preserve a figure/table with editable caption, and `[ref {"target":"stable-id"}]` preserves a structured reference. Inline and block math use LaTeX `$...$` / `$$...$$`; independent equations carry id/label in an attrs wrapper. Native JSON blocks preserve only subtrees that cannot be represented losslessly by these forms. Preserve these markers when changing nearby prose; removing a marker deliberately removes that formatting or content.

Submit `apply_body_candidate({ entry, regionId, baseRevision, markdown, range? })`. Optional range coordinates must come from this same native document revision and span complete sibling blocks. On a stale candidate, reread and reconcile; do not change baseRevision alone. A successful commit preserves other regions and raw data, updates an attached native editor in one undo step, and compiles the saved input. Use its `compile.revision` directly with `read_preview_pages`. `previewError` or `editorStatus: 'disconnected'` reports a failure after persistence; do not blindly repeat the edit. Without an attached editor the same service saves the body headlessly. A missing or exited Studio host cannot receive changes.

Keep caption, label, identity and number separate. A figure wraps one image/table/registered component/source block and an inline caption; moving it keeps these together. Human-readable labels can be edited, including Chinese labels; preserve the stable object `id` so references remain linked. New objects need ids and labels unique across the report. A reference stores the target id, not its label or computed number. Removing a target or its label leaves an unresolved reference that must be repaired before generation. Update handwritten `@old-label` in template/source files explicitly after a label rename; those are outside structured body reference management.

Use KaTeX-compatible LaTeX for the editor and check the same source in the actual MiTeX output. The generated runtime is pinned and supplied by Studio; do not add a package download/import to the template just for body equations. KaTeX and MiTeX macro support can differ. Templates must enable `math.equation` numbering when their independent equations are referenced. Do not write current “Figure 3” or “Equation (2)” into captions or Markdown to simulate numbering.

Manual review is also available in the body's Markdown candidate panel: capture the target to load the original Markdown, edit, inspect the comparison, and accept. Existing candidate edits require confirmation before replacing them with current original content. No Markdown disk mirror is maintained.

# Typst composition

Template source owns the page, fixed clauses, columns, paragraph indentation/spacing, figure captions and numbering. Compose chapters with native `#include`; editable prose is included from `/_editor/regions/<regionId>.typ`. Include referenced objects in the same final document. Do not build an include AST in body Markdown, edit generated files, or invent a generic body layout container. Editor reference suggestions only index body objects; arbitrary labels authored in templates remain native Typst concerns.

Read input with `#let data = json("/inputs/data.json")`. Keep input text as data/content instead of interpolating it into generated Typst source. Use `table` for data grids, explicit column widths when needed, and `table.header` for repeating headers. Captioned long tables are Typst figures; the template needs `#show figure.where(kind: table): set block(breakable: true)` to permit page breaks while keeping one captioned object. Prefer layout rules and reusable functions over manual spaces, repeated style blocks, or copying whole theme files. Inspect the current theme's interface before changing its arguments.

For Chinese labels inside equations, retain the shared theme's explicit math font list: `show math.equation: set text(font: ("New Computer Modern Math", "Noto Serif CJK SC"))`. The compiler bundles the math font; the workspace supplies the CJK font. A successful compile alone does not detect missing glyphs, and enabling system font fallback would make exported workspaces machine-dependent.

Keep ordinary edits small: modify the relevant file or exact text region, compile the affected same-name `.ts` entry, and resolve the returned source diagnostics before further edits. Re-read after a file-version conflict and reconcile the user's changes. For shared theme changes, compile the importing document entries as well.

A successful compile proves syntax and layout evaluation, not visual quality. `compile_preview({ entry, input: { kind: 'stored' } })` uses saved values; select `{ kind: 'data', data: {} }` for defaults or explicit data. The tool returns a revision, actual page count, page size ranges in points, and the first 128 outline items. Use those to choose pages; `read_preview_pages` returns actual PNG image blocks, page headings and source line ranges without recompiling. Supply the same entry and revision, and one to three one-based page numbers. For a multipage report inspect opening, table continuation and final pages; inspect every relevant page when the task requires complete review. Do not infer that unseen pages are correct.

Use `region: { x, y, width, height }` to inspect a suspect formula, image, table header or page break. Coordinates are page-local Typst points (1 pt = 1/72 inch), not image pixels; use the returned page dimensions and outline positions as a guide. `maxDimensionPx` defaults to 1600 and accepts 256–2048. Start with a full page, then crop when fine text is unreadable. The response states the actual pixel dimensions and crop region, so map image pixels back to points using the returned region. Large pages may reduce the scale to stay within the full-page raster budget; cropping retains the original page background. Source ranges identify which ordinary `.typ` files to read and edit.

Check long names, large numbers, formula glyphs, images, repeated table headers, column alignment, page breaks and the last row. After a change, compile the affected entry again and use its new revision. Old native revisions are rejected after source changes or a newer successful compilation. Changing only saved input does not invalidate an explicitly compiled snapshot. `export_pdf({ entry, revision })` writes the same compiled document and returns a complete immutable artifact path. The app retains files until expiresAt (at least 24 hours); copy them for long-term ownership. Read additional pages of an unchanged compilation without calling `compile_preview` again. The model must support image input; Studio recognizes known IDs/names from Pi and its bundled models.dev snapshot, with an explicit user override. If image inspection is disabled or fails, report that limit rather than asserting that the visual result is correct.

# External program access

Outside Pi, connect to a running Studio through `@report-template-studio/app/client`: discover, explicitly select instanceId and project.root, then use `withStudio`. `readBody({ projectId, entry, regionId? })` and `applyBodyCandidate({ projectId, entry, regionId, baseRevision, markdown, range? })` expose the same current-draft body flow as the built-in tools. Use these methods for prose changes rather than overwriting saved JSON through setInput. `compile({ projectId, entry, data, clientRevision: 0 })` captures explicit raw input and does not persist it; getInput explicitly if saved values are wanted. A region-enabled report also requires its complete `editor` draft; preserve it when compiling saved input. Track clientRevision across unsaved data/region changes; setInput requires the last read storageVersion as expectedVersion and reports a conflict without replacing another caller's draft. renderPage/exportPdf use the exact returned revision and return ready local paths; view the PNG with the agent image viewer. read/write use ordinary workspace paths and expectedVersion (null for a new file). A revision conflict requires an explicit new compile, never automatic replay. Client disconnect leaves the resident compiler alive. Shared filesystem/discovery visibility is required in Flatpak/containers. See the app README for the full exported-function example.

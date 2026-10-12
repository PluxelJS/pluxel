---
name: typst-authoring
description: Create or edit Typst documents and Valibot-backed input forms in a Typst Studio workspace, including shared themes, fonts, tables, and compilation diagnostics.
---

# Work from the document contract

Read `studio.json`, the affected same-name `.ts` report entry, its `template` `.typ` source, and imported shared theme before editing. Use the file tools to inspect only the relevant directories. `@folder` in the user's request identifies context to inspect, not a request to rewrite every file there.

A report is discovered by the naming convention `folder/folder.ts`, including nested folders. The entry must default-export `defineTypstDocument({ template, schema, createFiles? })` imported from `@pluxel/typst/template`. The entry filename supplies its name; do not declare a separate name. `createFiles` is synchronous. `template` is a `.typ` path relative to the entry directory and must resolve inside the workspace. Ordinary `.typ` files are source/modules, not standalone preview entries. No document list is stored in studio.json. Filename discovery keeps broken entries visible for repair. Keep shared typography, page setup, and table styles in reusable `.typ` functions; use relative imports such as `../../共享/主题/财务函件.typ`. Font directories are listed in `studio.json`; use the font's actual family name and preserve bundled licenses.

# Form defaults and input data

The same-name TypeScript entry defines its `schema` using `valibot` inside the document definition. Use native Valibot `v.title` and `v.description` for labels and descriptions; reserve `valibot-form` metadata for Studio-specific controls. Keep the schema inline in the definition unless another document actually reuses it. A typical report needs only its same-name `.ts` entry and `排版.typ`. Put demonstration values in Valibot defaults rather than duplicating a separate example-data object:

```ts
import * as v from 'valibot'
import { defineTypstDocument } from '@pluxel/typst/template'

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

Studio recursively combines `v.getDefaults(schema)` with external caller input, preserving explicit user values and replacing arrays as units, then validates with `safeParse`. Do not generate default data.json files or put form values into the workspace. Studio persists user input outside the workspace; another host supplies its business data directly. Only genuine source and static assets travel with templates. Without `createFiles`, validated input is exposed as `/inputs/data.json` in the compilation virtual filesystem, without writing a real file. A custom synchronous `createFiles(data)` returns a file map whose keys are under `/inputs/`, with `{ kind: 'json', value }` or `{ kind: 'text', text }` values. Do not perform I/O or install runtime packages in schema modules.

# Typst composition

Read input with `#let data = json("/inputs/data.json")`. Keep input text as data/content instead of interpolating it into generated Typst source. Use `table` for data grids, explicit column widths when needed, and `table.header` for repeating headers. Prefer layout rules and reusable functions over manual spaces, repeated style blocks, or copying whole theme files. Inspect the current theme's interface before changing its arguments.

For Chinese labels inside equations, retain the shared theme's explicit math font list: `show math.equation: set text(font: ("New Computer Modern Math", "Noto Serif CJK SC"))`. The compiler bundles the math font; the workspace supplies the CJK font. A successful compile alone does not detect missing glyphs, and enabling system font fallback would make exported workspaces machine-dependent.

Keep ordinary edits small: modify the relevant file or exact text region, compile the affected same-name `.ts` entry, and resolve the returned source diagnostics before further edits. Re-read after a file-version conflict and reconcile the user's changes. For shared theme changes, compile the importing document entries as well.

A successful compile proves syntax and layout evaluation, not visual quality. `compile_preview` returns a revision, actual page count, page size ranges in points, and the first 128 outline items. Use those to choose pages; `read_preview_pages` returns actual PNG image blocks, page headings and source line ranges without recompiling. Supply the same entry and revision, and one to three one-based page numbers. For a multipage report inspect opening, table continuation and final pages; inspect every relevant page when the task requires complete review. Do not infer that unseen pages are correct.

Use `region: { x, y, width, height }` to inspect a suspect formula, image, table header or page break. Coordinates are page-local Typst points (1 pt = 1/72 inch), not image pixels; use the returned page dimensions and outline positions as a guide. `maxDimensionPx` defaults to 1600 and accepts 256–2048. Start with a full page, then crop when fine text is unreadable. The response states the actual pixel dimensions and crop region, so map image pixels back to points using the returned region. Large pages may reduce the scale to stay within the full-page raster budget; cropping retains the original page background. Source ranges identify which ordinary `.typ` files to read and edit.

Check long names, large numbers, formula glyphs, images, repeated table headers, column alignment, page breaks and the last row. After a change, compile the affected entry again and use its new revision. Old images are rejected when source or input values change. Read additional pages of an unchanged compilation without calling `compile_preview` again. The model must support image input; Studio recognizes known IDs/names from Pi and its bundled models.dev snapshot, with an explicit user override. If image inspection is disabled or fails, report that limit rather than asserting that the visual result is correct.

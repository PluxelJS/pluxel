---
name: typst-authoring
description: Edit ordinary Typst source and JSON data in Studio, preserve labels and source semantics, and verify native compiled pages.
---

# Read the report contract

Read studio.json, the affected same-name folder/folder.ts entry, its relative template and relevant imports. The entry defines schema with native Valibot titles/descriptions/defaults; createFiles is an optional synchronous derived resource generator. Preserve unrelated files and licenses. TypeScript evaluation has no Node, network or filesystem APIs.

Raw business input is data.json beside the report entry. Schema defaults merge missing object fields; explicit empty strings, zero, false, null and array lengths retain their validation meaning. Parsed output can feed derived /inputs/data.json for existing templates. It never silently overwrites raw JSON. Ordinary Typst components may bind directly to json("data.json"). Keep values as data, not interpolated Typst code.

# Edit current source

Body authority is ordinary Typst. Same-name .editor.json declares sources relative to the entry and optional components. A component declaration identifies module/name and known string/number/boolean literal parameters; optional data identifies its JSON argument. Module code owns layout and computation. Unknown calls, comments and expressions stay in source.

Use read_body({ entry, path? }) to discover source files and capture unsaved desktop edits. Keep baseRevision. Apply with apply_body_candidate({ entry, path, baseRevision, source, range? }); ranges are UTF-8 byte offsets from this same revision. Do not guess Unicode offsets or change only a stale revision. Save applies to ordinary workspace files. No persistent Tiptap document, Markdown mirror or generated body tree is used.

Labels and references use native Typst identities. Keep figure body, caption, trivia and label together. Actual numbering belongs to final Typst layout. Rename all confirmed static references when changing a label; dynamic expressions require deliberate source review. Copies only rebind references internal to the copied range. Cross-file movement must preserve lexical scope and relative resources; do not move through set/show/import/let environment changes without proving equivalence.

The body candidate panel offers the same source review: fix file or complete block range, compare, then accept. Raw invalid source may be saved; it produces diagnostics and cannot be represented as a successful compile. Structured unsupported edits reject without changing source.

Use the copied lib/pluxel.typ helpers and fixed MiTeX files for editable LaTeX, references and JSON fields. Install report.document in the root template. KaTeX and MiTeX macro support can differ; verify actual native output. Compose chapters using native include/import. Page rules, captions, columns, spacing and shared themes remain ordinary Typst code.

# Verify the observable result

A save receipt is a persistence fact. previewError or editorStatus disconnected indicates a later failure; do not blindly retry a committed edit. Read the returned compile.revision with read_preview_pages. Without a compile receipt, compile_preview({ entry, input: { kind: 'stored' } }) uses saved sources/data, while kind data captures explicit caller data. Old previews are rejected after source or JSON changes or a newer compilation.

Inspect actual PNGs: opening, table continuation and final page for multipage reports, all relevant pages for complete review. Check glyphs, long text, column alignment, formulas, image sizing, table headers and final rows. Crop using page-local point coordinates where needed; 1 pt = 1/72 inch. Compilation alone proves no visual claim. If image inspection is unavailable, report that limit. export_pdf uses the same successful revision and returns an immutable artifact path; copy before its expiry for long-term retention.

External programs use @report-template-studio/app/client, explicitly choose instance and project, then readBody/applyBodyCandidate or compile/renderPage/exportPdf. getInput returns saved data and a complete source snapshot with workspace storageVersion; setInput requires it as expectedVersion. Client disconnect leaves the resident compiler alive. Do not create temporary bridges or per-operation hosts. A missing Studio host is a missing verification boundary.

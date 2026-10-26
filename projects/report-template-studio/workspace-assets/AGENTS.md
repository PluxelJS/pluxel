# Typst Studio workspace

This directory owns report source and static assets. Studio owns current user input and body drafts outside this workspace. Read `.agents/skills/typst-authoring/SKILL.md` before changing a report, its form contract, or its body.

## Source and data

- `studio.json` declares only the project name and workspace-relative font directories. Reports are discovered at `folder/folder.ts`, including nested folders; do not register documents in `studio.json`.
- The entry default-exports `defineTypstDocument({ template, schema, createFiles? })` from `@pluxel/plugin-typst/template`. Its filename supplies the report name. `template` resolves to a workspace `.typ` file relative to that entry; `createFiles` is synchronous.
- Keep a report to its entry and `.typ` source unless it actually needs shared modules or assets. Prefer native Valibot titles, descriptions and meaningful defaults. Raw caller input remains raw; schema defaults/transforms are derived compile values, not saved replacements.
- TypeScript document code runs in a restricted runtime with `valibot` and `valibot-form`; it has no Node, network or filesystem APIs. Do not install runtime packages or introduce default `data.json` files for form state. Preserve unrelated documents and static assets.

## Template and body ownership

The template owns pages, chapter composition, line/paragraph spacing, indentation, caption placement and numbering. It uses native `#include` for generated `/_editor/regions/<regionId>.typ` files; ordinary `.typ` chapter files can include them too. Do not reproduce the include graph in Markdown or Tiptap JSON.

A same-name `<name>.editor.json` enables named editable regions, bindable parsed-output fields and initial Tiptap documents. **Tiptap JSON is authoritative for body content.** Agent Markdown is an editing projection, not another stored file. `_editor/` and `/inputs/editor/` are reserved for generated content; do not create them in source or `createFiles`. Do not create Markdown mirrors or edit Studio's private input storage.

Use `read_body({ entry, regionId? })` to read current body content, including unsaved desktop edits. Preserve object ids, style/field/attribute markers, figure/caption wrappers, LaTeX source and reference targets unless the task changes them. Caption text and editable label are separate; references point to stable object ids. Renaming a label preserves structured references, but handwritten Typst `@old-label` still needs an explicit source edit. Templates control actual numbering. Raw Typst source blocks require the template's explicit opt-in; ordinary Markdown `typst` fences remain examples.

Submit `apply_body_candidate({ entry, regionId, baseRevision, markdown, range? })` using the exact read revision and range. A stale candidate requires rereading and reconciling, never replacing only the revision. Success persists the edit and returns `compile.revision`; use that revision to read preview pages without recompiling. `editorStatus: 'disconnected'` or `previewError` reports a post-save display/preview failure: inspect before retrying. An attached editor can undo the accepted change once.

## Verification and external access

Studio detects saved ordinary source changes. For source/form changes, use `compile_preview` with an explicit input choice: `{ entry, input: { kind: 'stored' } }` for saved values or `{ entry, input: { kind: 'data', data: {} } }` for defaults/explicit data. Inspect `read_preview_pages` at that revision, then `export_pdf` when requested. A shared theme change requires checking its affected reports; compilation alone does not prove visual quality.

External agents connect to the running app through `@report-template-studio/app/client`: discover and explicitly select instance/project, then use `withStudio`, `readBody` / `applyBodyCandidate` or explicit-data `compile`, `renderPage` and `exportPdf`. View returned PNG paths with the image viewer. Do not create temporary bridges, per-compile backends or workspace connection files. If no Studio is available, report that missing verification boundary; a plain Typst CLI does not validate schema/createFiles behavior.

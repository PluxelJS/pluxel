# Typst Studio workspace

This directory owns report Typst sources, raw JSON business data, shared modules and assets. Read `.agents/skills/typst-authoring/SKILL.md` before changing a report.

- Reports are discovered at `folder/folder.ts`. The entry default-exports `defineTypstDocument({ template, schema, createFiles? })`; template is a relative `.typ` path and createFiles is synchronous. `studio.json` declares only name and font directories.
- Raw form input is the report directory's ordinary `data.json`. Schema defaults/transforms are derived compile values and never silently overwrite raw JSON. Template code runs in the existing restricted runtime without Node or network IO.
- Body authority is ordinary `.typ` source. Same-name `.editor.json` declares `sources: [{ path, label? }]` relative to the entry, plus optional literal component declarations. The template composes ordinary files with native include/import. Do not introduce stored Tiptap JSON, Markdown mirrors, generated body directories or hidden input stores.
- Use `read_body({ entry, path? })` to capture current source including unsaved desktop edits. Preserve comments, unknown expressions, labels, caption content and resource paths. `apply_body_candidate({ entry, path, baseRevision, source, range? })` applies exact UTF-8 byte ranges or replaces the selected file. Stale candidates require rereading and reconciliation.
- A successful save returns a receipt. `previewError` or disconnected editor status reports failure after persistence; inspect before retrying. Use returned compile.revision with read_preview_pages without another compile.
- Layout, numbering and scopes belong to Typst. Component layout belongs to its ordinary module; string/number/boolean parameters and literal JSON binding can be edited structurally. Unknown syntax remains source. The copied lib/pluxel.typ and MiTeX files are normal project sources.
- Verify affected reports using compile_preview with stored or explicit input, then inspect actual read_preview_pages and export_pdf when requested. Shared modules can affect several reports. Compilation alone does not prove visual quality.
- External clients use the running Studio public client and explicitly select instance/project. Do not create per-compile hosts or private bridges. If the host is unavailable, state that verification limit.

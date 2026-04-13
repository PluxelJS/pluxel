# valibot-form Web Components Map

This folder is intentionally layered. Keep rendering logic predictable and avoid mixing schema planning with Mantine presentation.

## Directory Roles

- `AutoForm.tsx`
  Public root component and top-level orchestration.
- `SegmentedButtons.tsx`
  Shared public helper component used by form consumers.
- `internal/`
  Form context, field planning, field dispatch, and renderer plumbing.
- `chrome/`
  Shared field-level presentation wrappers such as label/help/error framing.
- `debug/`
  Lazy-loaded developer inspection helpers.
- `renders/`
  Schema-kind renderers. Each file should focus on one field family.

## Hard Rules

1. `internal/` decides what to render.
   `renders/` should not re-implement schema extraction or field planning.

2. `renders/` owns field-family UI.
   If a behavior is only for arrays, records, unions, etc., keep it in that renderer.

3. `chrome/` stays presentation-only.
   Do not move schema parsing, state coordination, or renderer dispatch into it.

4. Demo-only code must stay outside this folder.
   Do not import from `demo/` into production components.

5. Prefer Mantine primitives over custom chrome.
   If a renderer needs a panel, start from Mantine `Card`/`Paper` before inventing raw styled containers.

## LLM Edit Protocol

1. If the task changes field extraction or field metadata flow, edit `internal/`.
2. If the task changes how one schema kind looks or behaves, edit the matching file in `renders/`.
3. If two renderers need the same lightweight chrome, promote only that chrome into `chrome/`.

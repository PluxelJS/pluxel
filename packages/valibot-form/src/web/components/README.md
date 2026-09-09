# valibot-form Web Components Map

This folder is intentionally layered. Keep rendering logic predictable and avoid mixing schema planning with Mantine presentation.

## Directory Roles

- `AutoForm.tsx`
  Public root component and top-level orchestration.
- `SegmentedButtons.tsx`
  Shared public helper component used by form consumers.
- `internal/`
  Form context, field planning, path binding, field dispatch, and renderer plumbing. `BoundField` owns TanStack registration and maps field semantics to control props.
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

## Field ownership

`AutoForm.Fields` and structural renderers recurse with a `FieldNode` and a structured path.
`BoundField` registers representable paths and supplies value/change/blur/errors to controls.
Renderers must not split server error paths or rebuild ordinary parent objects for leaf changes.
Union discriminator transitions and Record key/row operations remain structural edits at their owner.
Union branches that replace the entire value reuse the current binding through `useValueRenderer`.

Literal keys that TanStack cannot represent are edited through the nearest bound ancestor without
changing their meaning. A literal root key with no such ancestor is read-only. Hidden fields keep
values in the form store without registering an invisible error target.

TanStack owns values and interaction metadata. Local state is limited to row identity/order,
uncommitted input and inactive Union branch drafts. Both the React facade and core FormApi reset
share the editing-session reset; do not infer resets from dirty-state transitions.

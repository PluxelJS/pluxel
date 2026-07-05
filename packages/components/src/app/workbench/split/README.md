## Workbench Split

This directory is the single home for workbench pane layout infrastructure.

- `view.tsx`
  `allotment` adapter and split view primitives.
- `storage.ts`
  layout normalization, persistence helpers, and sync hooks.
- `tabState.ts`
  active-tab scoped split state hooks.
- `plugin.ts`
  plugin workbench layout specs and state resolvers.
- `index.ts`
  public barrel for workbench split consumers.

Rules:

- Route and screen components should import from `workbench/split`.
- `allotment` specifics stay inside `view.tsx`.
- Layouts are stored as percentages, not pixels.
- Pane visibility state is scoped to the active workbench tab unless explicitly section-owned.

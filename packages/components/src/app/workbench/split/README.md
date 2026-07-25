## Workbench Split

This directory is the single home for workbench pane layout infrastructure.
The vendor integration rationale is documented in
`vendor/split-like-vscode/docs/pluxel-integration-design.md`.

- `view.tsx`
  `@worksplit/react` adapter and split view primitives.
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
- Split-pane library specifics stay inside `view.tsx`.
- Layouts are stored as percentages, not pixels.
- `WorkbenchSplitView` receives the current percentage `layout` and emits `onLayoutCommit` only
  after user pointer or keyboard resizing commits.
- Pane visibility state is scoped to the active workbench tab unless explicitly section-owned.

Workbench extension bundles outside `@pluxel/components` consume the narrow
`@pluxel/components/workbench-split` entry. It exposes the host-integrated two-pane view and
committed-layout persistence helpers without exposing Worksplit pointer events or shell internals.

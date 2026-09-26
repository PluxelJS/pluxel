## Workbench Split

This directory is the single Pluxel-owned home for workbench pane layout infrastructure.
`split-like-vscode` is an independent UI library: it owns generic pane constraints, resize math,
React components, CSS, and serializable layout values. It does not own Pluxel routes, tab identity,
persistence policy, plugin layout defaults, or Workbench lifecycle.

Pluxel consumes `@worksplit/react` as an ordinary library dependency. There is no
`@worksplit/vite`, code generation, virtual module, or host-specific API. The adapter keeps the
library replaceable and prevents its low-level event shapes from becoming application contracts.

## Files

- `view.tsx`
  `@worksplit/react` adapter, split view primitives, and the recursive editor-grid facade.
- `storage.ts`
  layout normalization, persistence helpers, and sync hooks.
- `tabState.ts`
  active-tab scoped split state hooks.
- `plugin.ts`
  plugin workbench layout specs and state resolvers.
- `index.ts`
  internal barrel for Workbench App consumers.

## Runtime boundary

```text
Workbench route / plugin screen
        -> active-tab percentage layout
        -> WorkbenchSplitView adapter
        -> @worksplit/react pixel layout
        -> pointer / keyboard / visibility event
        -> committed percentage layout
        -> WorkspaceController persistence
```

This is entirely a browser runtime path. It has no generated file, Vite hook, remote contract, or
server session.

Remote View Pane Kit adds a declarative layer above this private adapter:

```text
Remote WorkbenchPane declarations
        -> host validation bridge
        -> RemotePaneLayout container policy and tab-scoped state
        -> WorkbenchSplitView adapter
```

The native editor grid follows a separate host-owned path:

```text
WorkspaceController tabs + editor groups
        -> WorkbenchEditorGrid adapter
        -> @worksplit/react recursive editor topology
        -> committed topology/size snapshot
        -> WorkspaceController persistence
```

Pluxel owns drag/drop semantics, group focus, empty-group collapse, route mirroring, and per-Tab
document rendering. Worksplit never receives a Pluxel route or document identity.

## Rules

- Route and screen components should import from `workbench/split`.
- Only `view.tsx` may import `@worksplit/react` or its stylesheet directly.
- Section and Pane Kit layouts are stored as percentages. Recursive editor-grid snapshots keep
  Worksplit's topology and committed CSS pixel sizes, which resize proportionally with the host.
- `WorkbenchSplitView` receives the current percentage `layout` and emits `onLayoutCommit` only
  after user pointer or keyboard resizing commits.
- Pane visibility state is scoped to the active workbench tab unless explicitly section-owned.
- Remote plugin UI must use public capabilities such as `navigate()`, `openTab()`, and the Pane Kit and must not import this adapter,
  Worksplit, the Workbench router, or the workspace store.
- Change this adapter for Pluxel ownership, persistence, or tab behavior. Change Worksplit itself
  only for a reusable split-view behavior defect or capability.

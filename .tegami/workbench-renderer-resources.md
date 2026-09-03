---
packages:
  '@pluxel/auth':
    type: patch
  '@pluxel/fonts':
    type: patch
  '@pluxel/runtime':
    type: minor
  '@pluxel/rolldown':
    type: minor
  '@pluxel/wretch':
    type: patch
---

## Add lifecycle-owned Workbench renderer resources

Add exact descriptor-bound React renderer scopes with per-open query and mutation resources backed by a
private query-core `QueryClient`. Workbench owns portable RPC result detachment, subscription-driven
snapshot consistency, typed invalidation, single-flight mutation state, and teardown of subscriptions and
late transport results. Mutation hooks expose `mutate()` for event handlers and `mutateAsync()` when
callers need the detached result or explicit sequencing; preflight and operation failures remain observable
through Hook state.

Declare concrete queries with `query(factory)` and input-dependent queries with `queryFamily(factory)`;
both produce stable domain-readable query keys. Keep TanStack options at the top level while isolating
Workbench-owned behavior under `workbench.subscribe` and `workbench.invalidates`. Concrete queries are
exact typed invalidation targets, while query families expose only explicit `target(input)` and `all()`
choices. Direct Cap'n Web query and mutation results infer their detached DTO types without author-side
wrappers or result annotations.

Limit instance controls to the active Hook and current query-family input. Reject calls through stale
controls with `WORKBENCH_RENDERER_HOOK_INACTIVE`, preventing an observer from being resurrected without
its typed invalidation sidecar after cache collection.

Preserve exact View and Attachment API types in generated browser declarations, and allow one
renderer-specific scope module to import its exact definition without executing server-only definition
code in the browser producer.

Migrate the Auth, Fonts, Package Manager, and Wretch renderers onto the lifecycle-owned resources. Keep
Auth TOTP secrets short-lived by clearing settled mutation data immediately after copying the enrollment
draft and overwriting that draft on completion, start-over, semantic mode changes, and unmount. Normalize
Wretch settings snapshots by omitting absent optional fields so every returned snapshot remains portable.

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

Add exact descriptor-bound React renderer scopes with per-open query and mutation resources. Workbench
now owns portable RPC result detachment, snapshot/watch consistency, canonical keyed invalidation,
single-flight mutation state, and teardown of subscriptions, retries, and late transport results. Mutation
Hooks provide `mutate()` for fire-and-observe event handlers and `mutateAsync()` for result-driven flows.
Mutation hooks expose `mutate()` for event handlers and `mutateAsync()` when callers need the detached
result or explicit sequencing; preflight and operation failures remain observable through Hook state.

Keep resource declarations flat: queries accept top-level `watch`, mutations accept top-level static or
input-derived `invalidates`, unkeyed queries are exact typed invalidation targets, and keyed queries expose
only explicit `target(input)` and `all()` choices. Direct Cap'n Web query and mutation results infer their
detached DTO types without author-side wrappers or result annotations.

Preserve exact View and Attachment API types in generated browser declarations, and allow one
renderer-specific scope module to import its exact definition without executing server-only definition
code in the browser producer.

Migrate the Auth, Fonts, Package Manager, and Wretch renderers onto the lifecycle-owned resources. Keep
Auth TOTP secrets short-lived by clearing settled mutation data immediately after copying the enrollment
draft and overwriting that draft on completion, start-over, semantic mode changes, and unmount. Normalize
Wretch settings snapshots by omitting absent optional fields so every returned snapshot remains portable.

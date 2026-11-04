---
packages:
  '@pluxel/core': patch
  '@pluxel/host': major
  '@pluxel/services': major
  '@pluxel/workbench': major
  '@pluxel/host-vite': major
  '@pluxel/rolldown': major
  '@pluxel/create': major
  '@pluxel/test': major
---

## Select Host inputs explicitly per policy and Plugin node

Replace `runtime.state`, `runtime.configRecords` and `runtime.plugins` with top-level
`policy` and `config`. Eight policy fields independently select `declared-only`,
`declared-first` or `saved-first`; configuration records select the same modes per
exact Plugin node, including package definitions and forks. Constructor owners
resolve to default nodes. Declaration does not create a fork, load code or seed a
saved record. Execution budgets are bound before PluginService creation and changes
require a new Host.

`runtime.documents.config/state` now describe document access separately from input
precedence. `false` performs no document I/O and keeps mutations within the Host
session; borrowed storage factories run once after the Core root is ready. Remove
the old public store option and overlay authoring types. State documents use sparse
v7 records and configuration uses v4 raw input records; applications must convert
existing data explicitly before startup.

## Preserve raw input through transactional management

Configuration writes use `{ set?, remove? }`; reset removes saved paths to restore
inheritance. Reads distinguish `managedInput`, `effectiveInput` and parsed `config`,
with source, shadowing, revision, persistence and adoption facts. Validation failures
retain editable input snapshots. Preview and failed writes never publish candidate
configuration. Supply `expectedManagedRevision` to reject stale edits. Management
exposes policy get/validate/patch/reset and reports changed columns and persistence
separately from runtime adoption.

Management protocol major 9 and ConfigPresentationPlanV2 remove evaluated schema
defaults from presentation. Workbench edits raw saved input, keeps shadowed inputs
editable, restores inheritance through reset and retains drafts on conflicts.
Schemas and transforms execute only through effective configuration validation.
Composite Plugin and Part schemas reject validation issues even when a validator
also returns a partial value, so invalid subtrees cannot be saved as valid output.

Dev Console uses `dev.policy` instead of `dev.state.inspect`. Inspection returns
`inputs.config` and identifies explicit fork bindings. Starter applications and test
Host authoring use the same configuration and mutation contracts.

## Keep native document reads from rewriting external replacements

Passthrough filesystem reads leave access-time updates to the native filesystem.
Closing a reader can no longer write a stale file size over a concurrently replaced
Host document, which previously could append NUL bytes to a shorter external edit.

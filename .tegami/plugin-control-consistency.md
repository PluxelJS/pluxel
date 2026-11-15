---
packages:
  '@pluxel/test':
    type: major
  '@pluxel/core':
    type: patch
  '@pluxel/host':
    type: major
  '@pluxel/services':
    type: patch
  '@pluxel/workbench':
    type: patch
  '@pluxel/cli':
    type: patch
  '@pluxel/create':
    type: patch
---

## Select test nodes with source addresses

Test-host node operations take `Plugin.nodeAddress()` or `Plugin.nodeAddress('east')`.
The address retains the implementation needed to install a test Plugin and reject stale
implementations. Plain serialized addresses and generated control addresses cannot install code.
Repeated additions of one node reject conflicting implementation evidence before mutation.
The separate `definePluginFork` helper and `PluginForkRef` type are removed. Catalog assembly
and definition replacement continue to receive Plugin constructors. Existing tests, generated
projects, and documentation use the same node selection API.

## Preserve authoritative control results

Management lifecycle commands validate, execute, and project their receipts in one exclusive
operation. Concurrent commands retain the state produced by their own operation. Workbench
preserves complete batch results, including input rejection, partial application, lifecycle
issues, and uncertain persistence, when displaying feedback or preparing undo.

Single-node control receipts read the necessary Host state directly. Management display queries
reuse labels while their catalog inputs remain unchanged, avoiding repeated directory scans.

## Reuse instance and logging types

`PluginInstance<TAddress>` accepts source and generated addresses and preserves their instance
associations in unions. Configuration input/output helpers still require generated Schema
associations. Script log options use native `LogReadOptions` from `@pluxel/core/logging`;
the duplicate `ScriptLogReadOptions` export is removed.

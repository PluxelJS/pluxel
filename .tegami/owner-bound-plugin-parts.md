---
packages:
  '@pluxel/cli': patch
  '@pluxel/core': minor
  '@pluxel/create': patch
  '@pluxel/runtime': minor
  '@pluxel/rolldown': minor
  '@pluxel/test': minor
---

## Add owner-bound PluginPart composition

Add statically lowered `PluginPart` containment with automatic child Context/effects ownership,
composite Part configuration sections, owner-level optional Plugin edges, lifecycle diagnostics, and
Workbench tab projection. The Rolldown and Oxlint toolchain now validates the field-only Part authoring
contract and rejects constructors, dynamic occurrences, graph markers, and local containment cycles.

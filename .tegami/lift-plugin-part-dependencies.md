---
packages:
  '@pluxel/core':
    type: major
  '@pluxel/rolldown':
    type: major
  '@pluxel/runtime':
    type: major
  '@pluxel/test':
    type: major
  '@pluxel/cli':
    type: patch
  '@pluxel/create':
    type: patch
---

## Lift PluginPart dependencies into the owning Plugin

Allow concrete `PluginPart` classes to declare required Plugin dependencies in their constructors.
The toolchain lifts and deduplicates reachable Part requirements onto the owning Plugin graph, while
Core injects a distinct caller facade for each Part occurrence so registrations and cleanup retain
the Part Context without creating a Part graph node, lifecycle state, or provider override.

Required requests take precedence over optional requests in the effective owner graph and generated
package metadata. Provider failure, replacement, dependency override, rollback, and teardown continue
to apply to the whole owning Plugin generation.

Move generated Plugin metadata to lowering ABI v2, separating root constructor arguments, Part
constructor arguments, and aggregate graph requirements. ABI v1 artifacts are not accepted; update
Core, Runtime, Rolldown, and test tooling together, then rebuild Plugin packages and applications.

Update the CLI Plugin template and create-workspace guidance so generated repositories place Part
requirements at the actual consumer instead of repeating them in the owner constructor.

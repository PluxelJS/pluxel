## @pluxel/core@1.0.0

### Initial open-source release

Publish the supported Pluxel framework, runtimes, build toolchain, testing utilities, CLI, and
official public plugins. The current architecture, package boundaries, and public APIs are documented
in the repository; pre-open-source development records are intentionally not carried into this release
history.

### Add owner-bound PluginPart composition

Add statically lowered `PluginPart` containment with automatic child Context/effects ownership,
composite Part configuration sections, owner-level optional Plugin edges, lifecycle diagnostics, and
Workbench tab projection. The Rolldown and Oxlint toolchain now validates the field-only Part authoring
contract and rejects constructors, dynamic occurrences, graph markers, and local containment cycles.

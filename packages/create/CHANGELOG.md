## @pluxel/create@1.0.0

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

### Separate project creation from Plugin scaffolding

Ship a fixed, production-quality example monorepo and version-matched offline documentation from
`@pluxel/create`. Keep `pluxel new` focused on publishable Plugin packages with a strict manifest,
opt-in lightweight `.tpl` interpolation, immutable byte plans and exact overwrite preflight.

The example uses one host-owned Vite configuration for its React Todo UI and Plugin routes. Static
and dynamic development are modes of the same application server, while `host/web` is an independent
private workspace package for browser source and frontend-only dependencies without Pluxel imports.
The workspace root now preinstalls pncat as the only catalog-management interface and groups Pluxel,
frontend, backend, test and tooling versions without replacing package-level direct dependency declarations.

### Simplify generated repository verification

Generate the example monorepo with one canonical `verify` pipeline instead of an additional workspace-task alias.

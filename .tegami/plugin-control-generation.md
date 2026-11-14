---
packages:
  '@pluxel/rolldown': minor
  '@pluxel/host-vite': minor
---

# Generate and bind complete Plugin control declarations

Add the public `@pluxel/rolldown/control` entry and the production
`createPluginControlPlugin` Rolldown plugin. Plugin package, modules application
and standalone builds emit deterministic pure-data descriptors, complete native
class declaration materials, separate configuration and instance contracts, and
an integrity-checked manifest. Readable configuration types retain the original
Schema expressions, comments, defaults, validators and Part paths without
executing implementation code.

Plugin package control types retain the original installed class identity.
Application materials carry the local declaration closure for script authors who
do not have the application's source; referenced public type packages remain
consumer dependencies. Generated package control exports also appear in
publish exports and reject collisions with author-owned entries.

Register control assets through tsdown's own export generation after composing
the author's export customization. Repeated builds preserve package metadata
bytes and leave field ordering to the author's formatter.

Keep the author's native type resolution in both analysis and the frozen emit
mirror. Honor explicit TypeScript suppression directives for optional upstream
type imports while continuing to reject unresolved required declarations.
Use tsdown's resolved compiler project, including custom paths and explicit
no-project builds; direct generation selects its project from the build root.

Host Vite binds control materials to the actual evaluated module inputs and
committed Plugin implementation. Type-only dependency changes invalidate their
owning Plugin modules through the existing HMR batch driver. Analysis failures
leave an explicit unavailable control state. Semantic and configuration source
transforms preserve original source maps for this binding. Same-byte source
updates retain the existing Plugin implementation when decorator lowering adds
virtual helper modules.

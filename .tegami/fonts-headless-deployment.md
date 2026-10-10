---
packages:
  '@pluxel/fonts': major
---

# Declarative fonts and deployment default precedence

Load provider-owned fonts from the `FontsConfig.files` absolute path list using the same schema for Host, environment and file bindings. Core font discovery and registration no longer require Persistence or Workbench; saving preferences or managed uploads explicitly requires Persistence.

An available explicit `defaultFamily` configuration now takes priority over the saved font preference. Removing that configuration reveals the saved preference again. Configured font files preserve embedded families and participate in the portable font snapshot and provider byte limits.

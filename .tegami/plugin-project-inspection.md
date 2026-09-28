---
packages:
  '@pluxel/rolldown': minor
---

## Inspect Plugin source from ordinary TypeScript

Add `@pluxel/rolldown/inspect` with `openProject()` for workspace overview, package-root Plugin
discovery, PluginPart/config/dependency navigation, declared package checks, and reverse file ownership.
Queries reuse compiler semantics without evaluating project code, return source locations and explicit
analysis gaps, and reread source between calls. Results use existing Plugin identity and remain detached
from the query scope and running applications.

Correct workspace parsing so YAML lists after the pnpm `packages` block are not treated as workspace
members.

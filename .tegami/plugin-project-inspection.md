---
packages:
  '@pluxel/rolldown':
    type: minor
---

## Inspect Plugin source from ordinary TypeScript

Add `@pluxel/agent-sdk/source` with `inspectProject`, `listPlugins`, `inspectPlugin` and `inspectFile` for workspace overview, Plugin
discovery, PluginPart/config/dependency navigation, declared package checks, and reverse file ownership.
Queries reuse compiler semantics without evaluating project code, return source locations and explicit
analysis gaps, and reread source between calls. Results use existing Plugin identity and remain detached
from running applications.

Correct workspace parsing so YAML lists after the pnpm `packages` block are not treated as workspace
members.

---
'@pluxel/rolldown': patch
---

Deduplicate Drizzle in plugin source pipelines so database definitions, runtime handles, and plugin
queries share one package identity under pnpm peer variants and linked workspace development.

---
packages:
  '@pluxel/core': minor
  '@pluxel/host': patch
  '@pluxel/services': minor
---

## Keep Plugin label projection independent of Host

Move the shared pure Plugin label functions to Core. Logging formatters and Management catalog projection now consume Core directly; Host no longer re-exports the implementation through its internal entry.

Remove manager creation, active-owner lookup, and Context binding functions from the Logging public root. Framework integrations retain the existing internal entry. Applications install `logging()` as a Host service and access the installed manager through `Logging` or `host.ctx.logging`.

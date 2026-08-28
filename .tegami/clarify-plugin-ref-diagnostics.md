---
packages:
  '@pluxel/rolldown':
    type: patch
---

## Clarify optional Plugin ref diagnostics

Report namespace-qualified and other non-simple `definePluginRef<T>()` targets as requiring a direct
type-only named import, without incorrectly suggesting that the author supplied a runtime argument.

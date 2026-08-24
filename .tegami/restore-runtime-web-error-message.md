---
packages:
  '@pluxel/runtime':
    type: patch
---

## Restore the browser-safe RPC error projection

Export `rpcErrorMessage(error, fallback)` from `@pluxel/runtime/web` so Remote Views can turn an
unknown RPC failure into display text without importing internal session or transport modules.

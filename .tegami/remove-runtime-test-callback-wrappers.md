---
packages:
  '@pluxel/runtime':
    type: major
---

## Remove callback-based runtime test lifetime wrappers

Remove `withRuntimeHost()` and `withRuntimeContext()` from `@pluxel/runtime/test`. Create test
resources with `createRuntimeHost()` or `createRuntimeContext()` and own their lifetime explicitly
with `await using` or `dispose()` in a `finally` block.

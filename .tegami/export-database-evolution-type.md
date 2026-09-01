---
packages:
  '@pluxel/runtime':
    type: patch
---

## Make database declarations portable

Export the existing database evolution strategy type from `@pluxel/runtime/database` so TypeScript
can emit portable declarations for values returned by `defineDatabase()`.

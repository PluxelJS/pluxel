---
packages:
  '@pluxel/services': minor
  '@pluxel/create': patch
---

## Resolve Node and Worker artifacts from the deployed application

`standardServices({ nodeModules })` forwards the existing Node artifact configuration. Generated
applications resolve `artifacts/node` from `startup.deployment.root`, so Node modules and Workers
continue to load when the frozen application moves or starts from a different working directory.
Development still attaches its source compiler separately.

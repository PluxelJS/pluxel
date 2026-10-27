---
packages:
  '@pluxel/host': patch
---

## Run a fixed Plugin catalog in the browser

Add `@pluxel/host/browser` for browser and Web Worker composition using the same
`createHost` implementation and lifecycle as the server Host. The entry excludes
Node application loading and filesystem source discovery.

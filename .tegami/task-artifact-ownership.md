---
packages:
  '@pluxel/cli': patch
  '@pluxel/create': patch
---

# Keep cached build outputs with their owning task

Split CLI code and development resources, and generated applications' web, server, and distribution builds into native Vite Task dependencies. Each stage caches only its own outputs so a cached later stage cannot restore stale artifacts over a fresh build.

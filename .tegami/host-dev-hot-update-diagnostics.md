---
packages:
  '@pluxel/host-dev': patch
---

## Report rejected HMR candidates through the Host logger

Host development now reports errors from Vite hot-update handling through its existing structured diagnostics before propagating the original error to Vite. Semantic rejection retains the previous accepted artifact; failures while building an accepted producer plan continue to expose the Workbench producer failure state.

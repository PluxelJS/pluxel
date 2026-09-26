---
packages:
  '@pluxel/rolldown': patch
---

## Preserve resolved Vite environment values in conditional compilation

Register preprocessor configuration hooks at the top level and use native environment filtering for transforms. Source pipelines now honor the selected Vite mode and its loaded environment values when choosing conditional branches.

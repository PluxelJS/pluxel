---
packages:
  '@pluxel/workbench': patch
---

# Fix packaged Shell lazy assets

Build lazy imports and preload URLs under the Workbench asset mount instead of the application root.

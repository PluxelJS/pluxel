---
packages:
  '@pluxel/rolldown': patch
---

# Preserve native worker imports when relocating standalone applications

Standalone source-built Node artifacts resolve traced native dependencies from the deployment root. Their cache signature distinguishes deployment ownership from plugin-package ownership, so copied applications do not require the original source package to remain installed.

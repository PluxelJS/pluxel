---
packages:
  '@pluxel/host-vite': patch
---

# Reject development startup when Host initialization fails

First-start Host creation, service preparation, and application preparation failures now reject Vite startup after draining acquired resources. The CLI exits unsuccessfully without advertising a ready server. Source evaluation failures retain development watcher recovery, and later updates retain the existing replacement and compensation behavior.

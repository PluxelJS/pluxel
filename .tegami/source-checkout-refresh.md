---
packages:
  '@pluxel/cli': patch
---

# Keep nested source installs aligned with the Git CLI

Apply the implicit Pluxel checkout when installing provider workspaces, including providers with empty sources and their own development dependencies. Reject stale Git CLI artifacts before executing outdated commands and print the rebuild command.

---
packages:
  '@pluxel/workbench': patch
---

# Stop snapshot writes after workspace disposal

Flush the final workspace snapshot when its storage closes, then reject delayed
persistence scheduling and retries. Disposed workspaces can no longer overwrite
the saved state of a subsequently opened workspace.

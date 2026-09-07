---
packages:
  '@pluxel/cli':
    type: minor
---

## Discover the running CLI checkout and manage source registrations

Automatically use the Pluxel Git checkout containing the CLI when no explicit registration overrides it, including symlinked launchers and Git worktrees. Add `source list` and `source unregister` to inspect effective checkouts and remove registrations without deleting files. Source commands always run with the invoked CLI so project-local versions cannot interrupt source bootstrap; ordinary commands retain project-local delegation.

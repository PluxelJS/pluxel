---
packages:
  '@pluxel/create': patch
  '@pluxel/cli': patch
---

## Keep generated toolchain versions consistent

Align application and Plugin templates with the repository's Vite+ 1.4 toolchain,
including mise, the Vite override and peer allowance. Update their external catalog
ranges through the existing workspace synchronization command.

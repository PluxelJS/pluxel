---
packages:
  '@pluxel/rolldown': major
  '@pluxel/cli': major
---

## Keep author dependencies out of build metadata writes

Plugin builds now reject missing or misplaced provider peers and incorrect optional peer markers. Builds only refresh generated Plugin publication facts; they no longer move or delete dependency declarations or fill repository fields from CI environment variables.

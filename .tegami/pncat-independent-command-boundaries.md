---
packages:
  '@pluxel/cli': patch
---

# Preserve native pncat command boundaries

Use the invoking CLI in catalog-sync and detect migration guidance, keeping standalone pncat independent of Pluxel. Propagate package removal failures without retrying them as command-resolution fallbacks, and report failed shell hooks through pncat's existing warning contract.

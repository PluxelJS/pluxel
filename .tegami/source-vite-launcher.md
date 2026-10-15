---
packages:
  '@pluxel/cli': patch
---

# Run source build tasks through their own Vite+ installation

Source builds invoke the provider checkout's locally installed Vite+ launcher directly,
without a package-manager execution step that can implicitly install dependencies.
Independent pnpm sources and explicit source installation retain their package-manager policy.
Catalog command guidance uses `vp exec pluxel pncat`; workspace synchronization remains
the explicit Pluxel dependency-policy operation.

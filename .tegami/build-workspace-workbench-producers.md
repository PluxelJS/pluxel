---
packages:
  '@pluxel/rolldown':
    type: patch
---

## Build workspace Workbench producers from their owning package

Resolve generated Bridge entries and browser source graphs from the workspace package that declares
each producer while publishing its immutable MF2 artifact into the static application's deployment
root. Static production builds no longer look for package-owned generated entries under the host.
The semantic compilation carries that package root separately from the host deployment root. MF2 type
generation reuses the fixed shared build contract's workspace root, so cross-package renderer imports
need no caller override or second filesystem boundary discovery. The isolated producer build now uses
the toolchain-owned TypeScript compiler and accepts its generated explicit TypeScript import paths, so
dynamic type assets are validated consistently even when the owning package has no local compiler binary.

---
packages:
  '@pluxel/create':
    type: patch
---

## Enforce named catalog coverage in generated workspaces

Make the generated governance check reject bare third-party dependency versions while preserving local
workspace and peer dependency contracts. This turns the starter's named catalogs into an enforced
version-policy boundary instead of relying on pncat's informational detect output.

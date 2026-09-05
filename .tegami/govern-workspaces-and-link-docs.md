---
packages:
  '@pluxel/cli':
    type: minor
  '@pluxel/create':
    type: major
---

## Govern shared workspace policy and keep framework docs upstream

Add `pluxel workspace doctor` for the pnpm, workspace-file and source-bootstrap invariants shared by
Pluxel projects, while leaving product-specific package and directory rules in each repository. Add
`pluxel docs [path]` as the canonical documentation locator.

Stop copying a publication-time framework documentation snapshot into newly created workspaces.
Generated starters now link to the current upstream docs, pin the supported pnpm 11 release, run the
shared CLI governance check before their local governance rules, and keep `.pnpmfile.cjs` exclusively
owned by opt-in `pluxel source install`.

Make source overlays fully machine-local, validate their generated state with `source doctor`, derive
repository execution levels from package dependencies, preserve upstream Turbo cache hits by default,
and reserve frozen installs or forced builds for explicit flags. Packages with non-standard artifact
layouts can override build inference with `pluxel.sourceBuild`.

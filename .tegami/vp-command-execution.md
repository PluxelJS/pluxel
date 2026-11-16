---
packages:
  '@pluxel/create': patch
  '@pluxel/cli': patch
  '@pluxel/rolldown': patch
---

## Use the global Vite+ CLI for workspace execution

Use `vp install`, `vp exec` and `vp run` in setup instructions and development documentation.
Generated workspaces install plain hk hooks and run Pitchfork services directly, keeping
mise for pinned tool installation. Install Vite+'s native global CLI from its official
GitHub releases so it selects the declared package manager and delegates development
commands to the project-local toolchain. Remove environment and PATH injection from
the bundled mise configurations.

Install dependencies through Vite+ when scaffolding plugins or updating workspace membership,
and print `vp` commands for the next steps. Align the plugin template's package-manager pin
with the repository and application starter. Use the same command convention in template
documentation, generated agent instructions and installation hints.

---
packages:
  '@pluxel/cli': minor
---

# Use the bundled pncat commands and configuration API

Expose native pncat commands through `pluxel pncat` and publish `@pluxel/cli/pncat` with bundled runtime and self-contained TypeScript declarations. Consumer workspaces can manage dependencies without installing pncat separately. Source binding checks also honor pncat's target `--cwd`.

Keep catalog entries referenced by peer or optional dependency fields even when those fields are excluded from pncat migration.

Generate inline init configuration from `@pluxel/cli/pncat` with matching command guidance. Propagate native package-manager installation failures instead of reporting success.

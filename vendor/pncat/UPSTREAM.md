# pncat upstream

Source: https://github.com/jinghaihan/pncat

Revision: `97609c549a2c00f961c24a6e2e86e717f1710341` (0.13.4), MIT; see LICENSE.md.

This private workspace retains upstream `src/` and `test/`. Local changes:

- Source exports and relative internal imports support CLI bundling without a separate pncat build. The development `bin/pncat.mjs` uses tsx to run upstream's CLI; published Pluxel bundles `pncat/sync` and does not need this executable or loader.
- `src/sync.ts` provides noninteractive `planCatalogSync` / `applyCatalogSync`, reusing upstream WorkspaceManager, catalog handlers and YAML writer. Pluxel supplies version policy; pncat owns dependency parsing and writing.
- Bundled callers may supply `configModule` to resolve `pncat` config helper imports from the shipped implementation instead of a consumer installation.
- Sync loads only the target root's config and follows declared pnpm members, including explicit vendor members. Workspace globbing never follows symbolic links. Unlisted nested projects are not members.
- Development CLI adds `pncat sync [--check]`, a thin offline adapter over the same plan/apply API; existing upstream commands are retained.
- `src/cli.ts` exports `runCli` without import-time execution. It preserves upstream parsing and native argv layout when embedded as `pluxel pncat`; the original development binary invokes the same function. The bundled config loader resolves both the upstream `pncat` config import and Pluxel's published `@pluxel/cli/pncat` entry.
- Native `clean` checks all declared package dependency fields for catalog references, including peer and optional fields excluded from migration. Migration eligibility does not make a referenced catalog entry unused.
- `vitest.config.ts` preserves upstream test import aliases and adds focused sync coverage.

`planCatalogSync({ root, versions })` performs no registry requests, installation or writes. It updates only existing catalog entries, never package manifests. Ordinary bare dependencies eligible for migration are conflicts: callers must explicitly use native `migrate` before sync. Unknown policy packages do not become new package dependencies. npm alias policy values retain their full specifier.

Peer-only catalogs retain compatibility ranges. Changing a catalog also referenced by peers is a conflict; callers must explicitly separate the compatibility range from installed-version catalogs. Authoritative core upgrades and template generation may pass `preservePeerRanges: false`. Workspace/file/link protocols and unsupported complex bare ranges retain their existing declarations.

Plans report changes and conflicts. Apply rejects conflicts, changed input bytes, and changed membership before writing the workspace YAML through the upstream catalog writer. A plan is process-local and single use. Installation remains the caller's next explicit step.

Embedded `runCli` accepts an initialization context for the config import specifier and suggested command. Pluxel uses `@pluxel/cli/pncat` and `pluxel pncat`; standalone pncat keeps its original defaults. Native install subprocess failures propagate as command failures; install-command resolver fallback does not hide a subprocess failure.

Validation: `pnpm --dir vendor/pncat test` and `pnpm --dir vendor/pncat typecheck`.

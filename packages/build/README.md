# @pluxel/build (internal)

Internal build helpers for the Pluxel monorepo. This package is not meant for external consumption; it powers the local CLI and rolldown integration used by Pluxel plugins and packages.

## Contents

### Rolldown/Vite plugins

All plugins are exported from `@pluxel/build/rolldown`.

- `configSourcePlugin`
  - Extracts `@Config(...)` schema source and `configs.use(...)` schema usage at build time.
  - Injects `__setConfigSource__` / `__registerConfigSchema__` / `__registerUsedFeatures__`.
  - Uses the bundler’s parser (`this.parse`) and normalizes schema source via AST (no comment/TS syntax leakage).
- `importTypeFixerPlugin`
  - Converts type-only imports to runtime imports for constructor parameter DI in `@Plugin` classes.
  - Uses AST spans to safely remove `type` modifiers.
- `createImportTracker`
  - Tracks static/dynamic imports that match provided package prefixes.
- `appendDtsImport`
  - Appends a snippet to generated `.d.ts` assets.
- `rewriteDtsModuleAugmentations`
  - Rewrites `declare module 'x' {}` names inside `.d.ts` outputs.
- `rewriteDtsText`
  - Rewrites plain text inside generated `.d.ts` outputs (useful to prevent private module specifiers leaking).
- `assertBundleNoText`
  - Fails the build if forbidden text is found in generated outputs (excluding sourcemaps by default).

### CLI helpers

Exports live under `@pluxel/build/cli` and are used by Pluxel’s internal build tooling:

- `tsdown-runner` and related configuration helpers
- Shared CLI config/rules/utils

## Usage (internal)

```ts
import { configSourcePlugin, importTypeFixerPlugin } from '@pluxel/build/rolldown'

export default {
  plugins: [importTypeFixerPlugin(), configSourcePlugin()],
}
```

## Notes

- Parser support comes from the bundler (rolldown/vite) via `this.parse`.
- `oxc-parser` is only used in tests for schema normalization.
- Usage chain (intended): `@pluxel/hmr` / `@pluxel/cli` use `@pluxel/build` internally; published artifacts must not require users to install internal workspace packages (see `docs/PACKAGING.md`).

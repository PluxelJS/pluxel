# @pluxel/create

`@pluxel/create` owns the fixed Pluxel example workspace used by `pnpm create @pluxel`.

```sh
pnpm create @pluxel my-workspace
pnpm create @pluxel my-workspace --no-install
```

The package has no runtime dependencies and does not load `@pluxel/cli`. Its typed initializer is a
dedicated tsdown npm CLI entry: tsdown validates/generates the `create-pluxel` bin, preserves its
shebang, emits one Node 24 ESM chunk and uses the standard `copy` option to publish one immutable asset
tree:

- `dist/template/`: a neutral `@example/*` monorepo with an independent `host/web` workspace package, one
  host-owned Vite config, root-owned `pncat` catalog policy, static/dynamic modes, a same-origin Todo API,
  tests and build governance.

Creation copies the starter byte-for-byte and maps the package-safe `gitignore` asset to `.gitignore`.
It links to the canonical upstream documentation instead of copying a snapshot that drifts after
generation. The destination must be missing or empty. Assets are
validated as regular files without symlinks and staged in a sibling temporary directory before the
final rename.

`@pluxel/cli` remains a development dependency inside the generated workspace so users can run
`pluxel new` and build commands later. That generated-project dependency is not an implementation
dependency of this package. The starter root also installs `pncat` as the sole interface for catalog
changes; individual packages continue declaring their direct runtime, peer and development dependencies.
Generated governance rejects bare third-party versions so the named catalogs remain the single version
policy authority, while local package edges retain their package-owned workspace and peer contracts.

Maintainer checks:

```sh
pnpm --filter @pluxel/create test
pnpm --filter @pluxel/create test:starter
```

The packed smoke installs the generated workspace outside the repository, verifies its documentation
link, runs `pnpm verify`, starts the frozen static distribution and exercises both runtime modes of
the unified Vite application.

# @pluxel/test

> Status: published dev-only. It is intended for tests/tooling, not for production runtime dependencies.

Plugin authors should start with the repository-level
[`user-docs/testing.md`](../../user-docs/testing.md). It explains the standard Vitest setup, how to
choose between the core-only and runtime test hosts, lifecycle failure assertions, cleanup, HTTP,
Management Plane and fixture strategy.

Core-side test surface for Pluxel plugin semantics:

- Automatic core setup on import (`@pluxel/core/env` + services registration)
- A minimal core Host/Context API for integration/unit tests
- An opinionated Vitest preset (optional)

Runtime/HMR tests that need loader, config enabled bits, HTTP, vault, or runtime services should use
`@pluxel/runtime/test`. This package intentionally does not register runtime services by default.
The Host API is backed by `@pluxel/core/test`, so core lifecycle semantics have one shared
implementation across test packages.

Workspace tests can use `@pluxel/test/fixtures` for VFS-backed fixtures. External consumers should still prefer bringing their own fixture/fs library.
Each fixture owns its own filesystem instance. Prefer `await using fixture = await createFixture(...)`, then pass `fixture.fs` / `fixture.fsp` into the code under test.

```ts
import { createFixture } from '@pluxel/test/fixtures'

await using fixture = await createFixture({
	'packages/a/src/index.ts': 'export const entry = "a"\n',
})

await fixture.fsp.writeFile(fixture.getPath('tmp.txt'), 'ok\n', 'utf8')
expect(fixture.fs.existsSync(fixture.getPath('tmp.txt'))).toBe(true)
```

LLM-facing guide: `packages/test/LLM_TESTING_GUIDE.md`.

Toolchain/lint design: `docs/TOOLCHAIN.md`.

## Host

```ts
import { Plugin, BasePlugin, withHost } from '@pluxel/test'

await withHost(async (host) => {
	@Plugin({ name: 'P' })
	class P extends BasePlugin {}

	host.add(P) // or host.add([P1, P2, ...])
	await host.commit()

	const p = host.require(P)
})
```

The host above is core-only: it exercises `Context` + `PluginService` lifecycle semantics without
bootstrapping runtime services. Use `@pluxel/runtime/test` for tests whose behavior depends on the
runtime host.

### Draft vs commit

- `host.add(P)` / `host.add([P1, P2, ...])` only change the _draft_.
- `host.remove(P)` / `host.remove([P1, P2, ...])` only change the _draft_.
- `await host.commit()` applies the draft and is **strict** (throws if any plugin fails to start).
- If you expect failures and want a summary instead: `await host.commitAllowFail()`.

### Config

```ts
host.cfg(P).set({ answer: 42 })
host.cfg(P).unset('answer')
host.cfg('P').enable()
host.cfg('P').set({ answer: 42 })
```

### Forks

```ts
const ForkA = host.fork(P, 'a')
host.cfg(ForkA).set({ v: 'A' })
```

## Vitest

`vitest.config.ts`:

```ts
export { default } from '@pluxel/test/vitest'
```

Because the preset runs Pluxel build-correctness lint before transforms, the test project should
also install `oxlint` as a dev dependency.

Note: `@pluxel/core` installs a lightweight reflection provider (`@abraham/reflection`) and adds a small
compat shim so importing `reflect-metadata` later does not crash.

If a dependency truly requires `reflect-metadata`'s full semantics (key enumeration/deletion, etc),
import `reflect-metadata` explicitly in _your_ app/test entry **before** any decorated classes are evaluated.

### Workspace (monorepo)

If you have many workspace packages and want a single root `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		// Vitest Projects: treat each package config as a separate project.
		projects: ['packages/**/vitest.config.ts'],
	},
})
```

Each package can keep its own `vitest.config.ts` (typically
`export { default } from '@pluxel/test/vitest'`).

By default, `@pluxel/test/vitest` sets `passWithNoTests: !process.env.CI` to avoid breaking local workspace runs
when some packages have no tests.

The preset always enables the two Pluxel workspace conditions: internal packages resolve through
`@pluxel/source`, and plugin packages resolve their loader HMR entry through `@pluxel/runtime-dynamic`.

If you prefer automatic discovery instead of maintaining globs:

```ts
import { definePluxelVitestWorkspaceConfig } from '@pluxel/test/vitest'

export default definePluxelVitestWorkspaceConfig({
	test: {
		// optional: cap workers for very large workspaces
		fileParallelism: false,
		minWorkers: 1,
		maxWorkers: 1,
	},
})
```

If you need to add extra Vite plugins:

```ts
import { definePluxelVitestConfig } from '@pluxel/test/vitest'
import SomeTransform from 'some-transform/vite'

export default definePluxelVitestConfig(
	{ plugins: [SomeTransform()] }, // after Pluxel toolchain plugins
	{ prePlugins: [SomeTransform()] }, // before Pluxel toolchain plugins
)
```

## Unsafe exports

Toolchain/decorator-level APIs are intentionally separated:

```ts
import { __registerConfigSchema__ } from '@pluxel/test/unsafe'
```

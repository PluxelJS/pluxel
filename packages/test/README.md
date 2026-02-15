# @pluxel/test

Single test surface for Pluxel:

- Automatic core setup on import (`@pluxel/core/env` + services registration)
- A minimal Host/Context API for integration/unit tests
- An opinionated Vitest preset (optional)

LLM-facing guide: `packages/test/LLM_TESTING_GUIDE.md`.

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

### Draft vs commit

- `host.add(P)` / `host.add([P1, P2, ...])` only change the *draft*.
- `host.remove(P)` / `host.remove([P1, P2, ...])` only change the *draft*.
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

Note: `@pluxel/core` installs a lightweight reflection provider (`@abraham/reflection`) and adds a small
compat shim so importing `reflect-metadata` later does not crash.

If a dependency truly requires `reflect-metadata`'s full semantics (key enumeration/deletion, etc),
import `reflect-metadata` explicitly in *your* app/test entry **before** any decorated classes are evaluated.

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

Each package can keep its own `vitest.config.ts` (typically `export { default } from '@pluxel/test/vitest'`).

By default, `@pluxel/test/vitest` sets `passWithNoTests: !process.env.CI` to avoid breaking local workspace runs
when some packages have no tests.

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

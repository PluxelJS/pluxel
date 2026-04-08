# Pluxel Testing Guide (for LLMs)

This document describes how to write tests in this repo using `@pluxel/test`.

Goals:

- write tests that look like real plugin usage
- keep tests stable (avoid internal/private APIs)
- keep config/feature behavior correct (toolchain metadata extraction)

Repo-internal note:

- `@pluxel/test/fixtures` is for this monorepo only.
- Prefer `createFixture()` there for VFS-backed hermetic tests.
- Use `createDiskFixture()` only when the suite truly needs real paths, symlinks, `process.chdir(...)`, or external tooling/bundlers.
- Fixtures are isolated. Dispose them with `await using`, and pass `fixture.fs` / `fixture.fsp` explicitly into the code under test.

## Golden rules (must follow)

1. **Prefer `@pluxel/test` only**.
   - In tests, import from `@pluxel/test` (Host + decorators + base classes).
   - Do **not** import low-level decorator/toolchain hooks like `__registerConfigSchema__`.

2. **If you use `configs.use(...)` or `features.use(...)` in class fields, the class MUST be declared at module top-level**.
   - The metadata injection is done by a transform plugin at _module compile time_.
   - If you declare the class inside `it(...)` / inside a function, the transform **cannot** inject the metadata for that class.

3. **If an `@Plugin` constructor depends on another plugin class, do not use `import type` for that dependency.**
   - Constructor DI relies on runtime constructor metadata.
   - Repo lint now enforces and auto-fixes the safe cases before build.

4. **Never read `configs.use(...)` values in the constructor / field initializer**.
   - The field is a sentinel until the runtime injector runs.
   - Read config values in `init()` or other methods.
   - Repo lint enforces this (`pluxel/configs-use-no-early-read` and `pluxel/configs-use-no-redefault`).

5. **Do not put `configs.use(...)` on `#private` fields.**
   - Runtime config injection cannot assign to JS private fields.
   - Use a normal field (`private foo`) instead.

6. **Use the Host API to configure+start plugins**.
   - Do not call internal registration functions.

7. **Do not import `reflect-metadata` unless you actually need it**.
   - `@pluxel/core` installs a lightweight reflection provider (`@abraham/reflection`) on import.
   - `@pluxel/core` adds a small compat shim so importing `reflect-metadata` later does not crash.
   - If a dependency truly requires `reflect-metadata`'s full semantics (key enumeration/deletion, etc),
     import `reflect-metadata` explicitly in your test/app entry **before** any decorated classes are evaluated.

Lint note:

- `pluxel/configs-use-top-level-class` enforces module-top-level `this.configs.use(...)` declarations.
- `pluxel/configs-use-no-private-field` rejects `#private = this.configs.use(...)`.
- `pluxel/features-use-top-level-class` does the same for `this.features.use(...)`.
- `pluxel/plugin-constructor-no-type-only-imports` enforces runtime imports for `@Plugin` constructor deps.
- Internal build/test/HMR toolchains run `oxlint.build.config.ts` before transform; only build-critical correctness rules are forced there, and violations fail early instead of being silently rewritten.
- `pnpm lint:fix` only applies the safe autofix subset; expect remaining `pluxel/*` findings to need an intentional manual rewrite or an explicit suggestion accept.

## Recommended setup (Vitest)

Use the preset so toolchain metadata extraction is available:

`vitest.config.ts`

```ts
export { default } from '@pluxel/test/vitest'
```

If you need extra Vite plugins in your test pipeline, use:

```ts
import { definePluxelVitestConfig } from '@pluxel/test/vitest'
import ExtraTransform from 'some-transform/vite'

export default definePluxelVitestConfig(
	{ plugins: [ExtraTransform()] }, // runs AFTER Pluxel toolchain plugins
	{ prePlugins: [ExtraTransform()] }, // runs BEFORE Pluxel toolchain plugins
)
```

You normally **do not** need to import `@pluxel/test/setup` manually:

- `@pluxel/test` already imports `@pluxel/test/setup`
- the Vitest preset also runs it via `setupFiles`

## Core testing primitives

### `withHost(fn)`

Runs a test with a fresh `Context` + `PluginService` and auto-disposes.

```ts
import { describe, it, expect } from 'vitest'
import { Plugin, BasePlugin, withHost } from '@pluxel/test'

@Plugin({ name: 'P' })
class P extends BasePlugin {}

it('starts a plugin', async () => {
	await withHost(async (host) => {
		host.add(P) // or host.add([P1, P2, ...])
		await host.commit()
		expect(host.isRunning(P)).toBe(true)
	})
})
```

`await host.commit()` is **strict** (throws if any plugin fails to start). If a test intentionally introduces a failing plugin, use `await host.commitAllowFail()` and assert on `host.last()?.failed`.

### `host.cfg(target)`

Configure a plugin by ctor **or** by plugin id string:

```ts
host.cfg(P).set({ answer: 42 })
host.cfg(P).unset('answer')
host.cfg('P').enable()
host.cfg('P').set({ anyKey: 'ok' }) // string target is intentionally untyped
```

### `configs.use(schema)` (type-safe config fields)

Declare config fields:

```ts
import type { StandardSchemaV1 } from '@standard-schema/spec'

const PassthroughSchema: StandardSchemaV1 = {
	'~standard': { version: 1, vendor: 'test', validate: (v) => ({ value: v }) },
}

@Plugin({ name: 'Cfg' })
class Cfg extends BasePlugin {
	foo = this.configs.use(PassthroughSchema)
	override init() {
		// safe to read here
		this.foo
	}
}
```

Then set config before start:

```ts
host.cfg(Cfg).set({ foo: 'hello' })
await host.start(Cfg)
```

### `features.use(FeatureCtor)` + `@UseFeature(...)`

Preferred (toolchain-friendly) pattern: **declare feature usage as class fields**.

```ts
import { BaseFeature, UseFeature } from '@pluxel/test'

class CacheFeature extends BaseFeature {
	static featureKey = 'cache'
	cfg = this.configs.use(PassthroughSchema)
}

@UseFeature(CacheFeature)
@Plugin({ name: 'Host' })
class Host extends BasePlugin {
	cache = this.features.use(CacheFeature)
}
```

Notes:

- `@UseFeature(...)` is always safe and works without toolchain transforms.
- `this.features.use(...)` in a class field enables extra toolchain metadata extraction; keep it at top-level.

### Forks

```ts
import { ForkablePlugin } from '@pluxel/test'

@Plugin({ name: 'Forkable' })
class Forkable extends ForkablePlugin {}

await withHost(async (host) => {
	host.add(Forkable)
	const A = host.fork(Forkable, 'a')
	host.cfg(A).set({ v: 'A' })
	await host.commit()
})
```

## Base tokens / multiple implementations

If you are testing DI resolution with an abstract base token:

- use `@Plugin(BaseToken, { name: 'Impl' })` to register a provider
- use `setParamToken(Consumer, index, BaseToken)` to force DI token
- test conflicts by registering multiple providers for the same base token

This is a **test pattern**, not extra test-package API — keep it as test code.

## What NOT to use (internal APIs)

Avoid these in normal tests:

- `__registerConfigSchema__`
- `__registerUsedFeatures__` / `__registerUsedFeature__`
- `pluginMethodDecorator(...)`
- `requirePluginDependency(...)` / `resolvePluginDependency(...)`

They exist for toolchain-level tests only and are intentionally separated:

```ts
import { __registerConfigSchema__ } from '@pluxel/test/unsafe'
```

If you think you need `@pluxel/test/unsafe`, you are probably writing:

- a test for the build transform itself, or
- a test for decorator metadata edge cases

Otherwise: rewrite your test using `withHost` + `host.cfg(...)` + `host.commit(...)`.

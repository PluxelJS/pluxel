---
packages:
  '@pluxel/host': major
  '@pluxel/host-dev': major
  '@pluxel/rolldown': major
  '@pluxel/services': major
  '@pluxel/workbench': major
  '@pluxel/create': major
---

## Declare applications with one deferred configuration factory

Applications now default-export `defineConfig(startup => ({ ... }))` from `@pluxel/host`.
The factory returns the complete application configuration, synchronously or asynchronously;
plain application exports and nested `configure` merging are removed. Each Host receives a
shallow immutable startup snapshot shared by its factory and `prepare` callback. The helper
preserves the inferred factory result and checks unsupported top-level fields.

## Keep development and production assembly consistent

Builds inspect inline factories without executing them and reject production plugin catalogs
that cannot be resolved statically. Module-level and imported constant plugin arrays remain
supported. Explicit environment and file bindings are described in the unified configuration change.

Re-evaluating an application factory replaces its Host; fixed-catalog execution reports this as
`host-reload`. Dynamic source-only updates retain catalog HMR when the application factory is
unchanged. Factory evaluation failures retain the running Host; failed replacement preparation
recreates a Host from the previous successful factory. The starter and application documentation
use the same factory declaration.

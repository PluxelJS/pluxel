# @pluxel/runtime-dev

Private workspace package for route-neutral runtime development glue.

This package is not published as a public Pluxel package. `@pluxel/runtime-static` and
`@pluxel/runtime-dynamic` use it as source during repository builds and inline its code into
their own published HMR/dev chunks.

## Responsibility

`runtime-dev` owns only development behavior that is independent from the plugin loading route:

- bind `ui(...).bind(ctx)` source declarations to runtime HMR handles
- watch plugin UI source files and related generated source roots
- hash source inputs, shared package signatures, and UI build options
- build source UI entries into web Module Federation remotes through `@pluxel/rolldown/vite/plugin-ui`
- commit compiled extension modules into the runtime extension store
- manage compile concurrency, disk cache reuse, cache cleanup, and watcher disposal

It does not own a host HMR model.

## Non-goals

Keep these outside this package:

- dynamic workspace scan, profile resolution, package installation, module adapter, and `executeFiles`
- static runtime catalog diffing, static definition re-import, and fixed plugin enablement
- Rolldown/OXC/Vite plugin implementation details
- public API intended for application authors

## Packaging

This package is `private: true`. Published consumers must never import it.

Route packages should:

- keep `@pluxel/runtime-dev` in `devDependencies`
- alias `@pluxel/runtime-dev` to this package's `src` entry in tsdown
- inline it with tsdown `alwaysBundle`
- keep `@pluxel/rolldown`, `@pluxel/runtime`, and `vite` external
- ensure generated public `.d.ts` files do not mention `@pluxel/runtime-dev`

When a route package inlines this package, it must also declare the runtime dependencies used by
the inlined code, currently `chokidar` and `pathe`.

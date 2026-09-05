# {{packageName}}

{{description}}

Before changing plugin code or package/build configuration, consult the documentation matching the
installed Pluxel version. Run `pnpm exec pluxel docs` for the canonical upstream documentation entry;
keep this package README focused on its own contract instead of copying framework documentation.

## Install

```sh
pnpm add {{packageName}} @pluxel/runtime
```

Import the root named Plugin export into a static catalog or expose the same package root through a
dynamic catalog/source producer. Both routes use the same lowered definition address;
class/display name is not identity.

```ts
import { {{className}}Plugin } from '{{packageName}}'

export const plugins = [{{className}}Plugin]
```

## Develop

```sh
pnpm install
pnpm verify
```

`verify` checks Oxfmt, Oxlint with the Pluxel rule plugin, unused lint suppressions, types, tests, and
the production plugin build. Runtime is a peer dependency; build and test tooling stays in
development dependencies. `pnpm-workspace.yaml` owns their shared compatible ranges through the
catalog and explicitly allows the esbuild install script required by the toolchain.

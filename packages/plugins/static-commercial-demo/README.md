# Static Commercial Demo

`@pluxel/plugins-static-commercial-demo` is a commercial-style static demo for `packages/plugins`.

It combines:

- `@pluxel/runtime-static` fixed catalog as the backend driver
- `staticRuntimeVitePlugin(...)` mounting that backend into the host Vite dev server
- `CommercialDataPlugin` providing a reusable Drizzle + libSQL business data capability
- `StaticCommercialPlugin` mounting `graphql-yoga` through `this.ctx.http.plugin.routes(...)`
- `@gqloom/core` + `@gqloom/valibot` for code-first backend schema and resolvers
- `@gqlens/vite` for frontend accessor generation
- React UI that reads and mutates a small order pipeline through the Pluxel plugin route

The example is intentionally split into two plugins:

```text
CommercialDataPlugin
  -> owns libSQL startup, schema creation, schema-version check, seed data, Drizzle queries
  -> exposes a typed services facade

StaticCommercialPlugin
  -> depends on CommercialDataPlugin through Pluxel constructor injection
  -> owns GraphQL Yoga, GQLoom resolvers, and the React UI entry
```

That split is the point of the demo: a static Pluxel plugin can act as backend infrastructure
inside the host Vite process, and another business plugin can consume it without knowing whether
the data comes from SQLite, a remote API, or a different provider plugin.

The local database is provided through `@libsql/client/sqlite3` and queried through
`drizzle-orm/libsql/sqlite3`. The database is persisted under the runtime persistence root:

```text
packages/plugins/static-commercial-demo/.pluxel/static/persistence/plugin-data/CommercialDataPlugin/commercial.db
```

Run:

```sh
pnpm --filter @pluxel/plugins-static-commercial-demo dev
```

The browser talks to one Vite origin. Vite serves frontend modules, while Pluxel handles
`/__pluxel/*` and shell navigation through the static host:

```text
Vite /__pluxel/plugins/StaticCommercialPlugin/graphql
  -> staticRuntimeVitePlugin(...)
  -> @pluxel/runtime-static host
  -> CommercialDataPlugin
  -> StaticCommercialPlugin
  -> Yoga + GQLoom resolver
  -> Drizzle service facade
```

Vite consumes the runtime config from `src/pluxel.static.ts`. Lifecycle, HMR source UI wiring,
request forwarding, and shutdown are delegated to `@pluxel/runtime-static/vite`. Plugin source is
never started through a raw TypeScript runner.

The static host entry uses the same Vite/Rolldown pipeline:

```sh
pnpm --filter @pluxel/plugins-static-commercial-demo static
```

Build:

```sh
pnpm --filter @pluxel/plugins-static-commercial-demo verify
```

# Static Commercial Demo

`@pluxel/plugins-static-commercial-demo` is a commercial-style static demo for `packages/plugins`.

It combines:

- `@pluxel/runtime-static` fixed catalog as the backend driver
- `StaticCommercialPlugin` mounting `graphql-yoga` through `this.ctx.http.plugin.mount(...)`
- `@gqloom/core` + `@gqloom/valibot` for code-first backend schema and resolvers
- `@gqlens/vite` + `@gqlens/codegen` for frontend accessor generation
- React UI that reads and mutates a small order pipeline through the Pluxel plugin route

Run:

```sh
pnpm --filter @pluxel/plugins-static-commercial-demo dev
```

The browser talks to one Vite origin, but GraphQL is served by Pluxel:

```text
Vite /__pluxel/plugins/StaticCommercialPlugin/graphql
  -> @pluxel/runtime-static host
  -> StaticCommercialPlugin
  -> Yoga + GQLoom resolver
```

The standalone static host can also be started without Vite:

```sh
pnpm --filter @pluxel/plugins-static-commercial-demo static
```

Build:

```sh
pnpm --filter @pluxel/plugins-static-commercial-demo verify
```

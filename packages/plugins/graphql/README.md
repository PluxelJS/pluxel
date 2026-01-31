# @pluxel/graphql

Builtin GraphQL runtime + optional GQty codegen.

This plugin provides a GraphQL runtime by wiring into `ctx.honoService.setGraphQLFetch(...)` and
exposes a plugin-to-plugin API (`features.dep(GraphQLPlugin)`) for registering modules.

## Configuration

Config key: `graphql` (plugin config).

```ts
host.cfg(GraphQLPlugin).set({
  graphql: {
    codegen: {
      enabled: true,
      destination: './packages/components/src/app/gqty/index.ts',
      endpoint: 'http://localhost:3000/graphql',
    },
    scalarTypes: { Number: 'number' },
  },
})
```

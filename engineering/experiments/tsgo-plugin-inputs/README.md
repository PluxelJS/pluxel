# Explicit plugin input bindings experiment

This is an isolated design experiment. It changes no production API and installs no dependency.
It uses the workspace's TypeScript 7.0.2, Valibot, and Standard Schema declarations. The `paths`
entries locate existing workspace dependencies; emitted declarations retain normal package imports.

The explicit design preserves an arbitrary private `this.configs.use(schema)` field and exports
that one schema value for Host imports. The Host declares mappings, not a second schema:

```ts
envBinding(ExamplePlugin, {
	config: { schema: ExampleConfig, mapping: { payload: { raw: 'APP_RAW' } } },
	vault: {
		schema: ExampleCredentials,
		mapping: { credentials: { token: 'APP_TOKEN' } },
	},
})
```

The config schema must be identical to the existing lowering metadata schema. The demo's
`assertDeclaredConfigSchema` illustrates that check without adding runtime metadata machinery.
The Vault root schema is a Host deployment contract, retaining record key validation. It does
not validate arbitrary plugin-private KV state and does not imply that plugin code declared a
Vault schema. A smaller per-record `env(schema, mapping)` example is included for comparison;
it must not replace a root Vault schema when record key constraints need validation.

Run from the repository root:

```sh
pnpm exec tsc -p engineering/experiments/tsgo-plugin-inputs/tsconfig.explicit.json
pnpm exec tsc -p engineering/experiments/tsgo-plugin-inputs/tsconfig.explicit-consumer.json
node engineering/experiments/tsgo-plugin-inputs/check-completion.mjs
```

The consumer imports only `.explicit-out/explicit-bindings.d.ts`. With `strict: true` and
`skipLibCheck: false`, defaults remain optional inputs, transformed fields retain their input
shape, and invalid mapping keys fail using `@ts-expect-error` assertions. No content mapper,
source augmentation, generated schema brand, or class static property is involved.
The actual TypeScript 7.0.2 LSP reports config keys `mode`, `payload`, `transport`,
nested `raw`, Vault root `credentials`, and record `token`, and diagnoses an invalid
`wrongKey`. See `explicit-lsp-results.json`. Do not wrap the entire mapping in `NoInfer`: the
probe found that it suppresses root property completion; removing it retained all negative
type assertions.

## Protected field alternative

The separate `protected-bindings.ts` probe preserves the schema input through an optional symbol
brand on `configs.use()` output and a fixed protected `config` field. Access through
`InstanceType<P>['config']` compiles in both installed TypeScript 5.9.3 and 7.0.2, unlike direct
indexing on an instance type parameter. Emitted declarations retain the protected field type.
No-declaration plugins and fields with an annotation that erases the brand reject bindings.

```sh
pnpm exec tsc -p engineering/experiments/tsgo-plugin-inputs/tsconfig.protected.json
pnpm exec tsc -p engineering/experiments/tsgo-plugin-inputs/tsconfig.protected-consumer.json
node node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p engineering/experiments/tsgo-plugin-inputs/tsconfig.protected.json
node node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p engineering/experiments/tsgo-plugin-inputs/tsconfig.protected-consumer.json
```

This is not a recommended production contract: it requires a fixed protected field, introduces
a type-only symbol into the output type, and still needs a distinct Vault declaration design.
The first actual 7.0.2 LSP probe of the protected fixture with `NoInfer` returned `toString`
and `valueOf` at the config mapping cursor, despite successful typechecking. A separate minimal
control reproduced that behavior with explicit schemas: it is a contextual typing limitation of
the `NoInfer` formulation, not evidence that protected fields themselves prevent completion.
The protected alternative without `NoInfer` has not been claimed as tested. Passing type
assertions alone does not establish editor completion quality.

## Actual public Host declarations

After building the production Host and its dependencies, run the optional public-package check:

```sh
node engineering/experiments/tsgo-plugin-inputs/check-production.mjs
```

This creates an isolated temporary consumer with symlinks to the real package roots. It uses
ordinary default package exports, no `@pluxel/source` condition, and no `paths` overrides. The
compiler's resolved file list must contain both `@pluxel/core` and `@pluxel/host` built `dist/index.d.mts`
and must not contain their source files. The temporary directory is removed on completion.

`production-consumer.ts` imports the actual `envBinding`, `fileBinding`, `defineConfig`, and
`BasePlugin`. Strict compilation with `skipLibCheck: false` checks optional/defaulted and
transformed schema inputs, valid environment/file bindings, and ten negative assertions covering
invalid config fields, transformed input paths, array/dynamic-record projection, Vault keys,
Vault fields, Vault root shape, and file record keys. The real TS7 LSP checks root/nested config
and Vault completion, file record key completion, and an unsuppressed invalid-key diagnostic.
Its application entry uses direct `envBinding(...)` calls inside the `envBindings` array, matching
the static build parser's accepted source shape. The Rolldown static declaration test parses this
same fixture and checks the resulting environment names.
This validates the production declarations in addition to the standalone experiment above.

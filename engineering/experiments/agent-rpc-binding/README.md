# RPC Command declaration and binding experiment

This is an executable prerequisite for section 13, item 1 of
[AGENT_RPC_COMMANDS.md](../../proposals/AGENT_RPC_COMMANDS.md). It does not publish an RPC API.

Run from the repository root:

```sh
packages/services/node_modules/.bin/tsx engineering/experiments/agent-rpc-binding/check.mjs
packages/services/node_modules/.bin/tsx engineering/experiments/agent-rpc-binding/check-build.mjs
packages/services/node_modules/.bin/tsx engineering/experiments/agent-rpc-binding/check-production.mjs
node_modules/.bin/tsc --noEmit --pretty false -p engineering/experiments/agent-rpc-binding/tsconfig.json
```

The first command writes [artifact.json](artifact.json) and
[generated-client.d.ts](generated-client.d.ts). The second command checks actual client use,
including the Transform's **string wire input**, the cross-package `Receipt` success value,
`RpcResult<Receipt>` rather than a nested Result, and the discriminated RPC failure branches.
The fixture imports the real `defineCommand` and `Result` from `packages/commands`; it runs
the write command and checks both its receipt and invalid wire input.

The build probe temporarily links the fixture provider as `@fixture/records-provider`, then
resolves that package's export through Rolldown. Its build plugin checks the current source
artifact at the publication module and injects `rpcPublication` into the bundled output. The
injected `bindings` import the exact Command export objects, so a descriptor-identical copy
fails the strict reference check used at publication.
The output runs the real write Command. A changed Command binding and a description-only
change both reject an old artifact at build time; a refreshed description artifact keeps the
same authorization hash. The temporary package link and output directory are removed after
the run. The package export points to TypeScript source; this does not test a packed package.

The production probe uses the shared `createPluginBuildPipeline()` and Vite source pipeline
against an actual `@Plugin` module. It packs and installs a provider whose package export
includes the static Command TypeScript source. The built module's generated
`__pluxelRpcPublications` export and the publish call share the exact artifact and Command
binding objects. The artifact and its nested contract, methods, schemas, and types are frozen.
The emitted `.d.ts` asset passes the workspace TypeScript 7 CLI, including wrong-input and
missing-result-field rejection. Vite transforms the same source successfully. Whitespace
before `publish (` is recognized; indirect publish is rejected; ordinary modules emit no RPC
artifact. A packed JS/declaration-only provider and a package whose TypeScript source
condition differs from Rolldown's selected export both fail with explicit diagnostics.
The admitted publish site is inside an exported `@Plugin` class in the same module. Each
manifest entry names that class and its package-relative module path. The runtime artifact
contains the exact declaration string, including the API-specific `rpc.open(id)` signature.
The production probe also links the real `@pluxel/services/rpc` package, starts the generated
Plugin in a Host with `rpc()`, creates an exact-contract session, calls the real `read`
and `write` Commands, and verifies an unlisted method is rejected. The write input exercises
a string-wire Transform, an optional nested object, an array of closed objects, Boolean and
Number fields, and an optional nested field. The probe compares the generated schema to the
runtime Command descriptor before publishing; Host publication and a real write call then
verify the binding. The bundle keeps `@pluxel/*`
packages external, matching the package preset's shared runtime identity.

The admitted wire schema subset in this probe includes closed nested objects, arrays,
Boolean and Number fields, optional fields, static defaults, and numeric and array
constraints. The exercised Transform encodes the offset as a string; the generated client
therefore accepts a string. Schema annotations (`description`, `title`, `examples`, `$comment`) do not affect the
authorization hash, while a business property named `description` and its default do.
Unrecognized schema keywords and union wire schemas fail generation. The DTO printer supports
the exercised finite JSON object, primitive, array, and union types; it rejects `any`,
`unknown`, index signatures, tuples, intersections, recursion, callables, `Date`, and other
native/non-JSON values. These are probe admission rules, not a public schema support promise.

## Observed binding and hash behavior

The TypeScript 6 compiler API follows the static method table to the referenced Command
declarations, verifies calls to the real `defineCommand`, and extracts the public `execute`
parameter and Result success branch. The experiment uses TypeScript 6 for compiler API
inspection because the installed TypeScript 7 CLI has no supported JavaScript compiler API;
the generated declaration is checked by the workspace TypeScript 7 CLI.
The publication pass checks diagnostics in the publication module; imported packages use
their own TypeScript settings and package build checks.

The generated artifact records the method names, actual Command names and runtime
descriptors, typed client declaration, source file digests, and Command export references.
`bind()` checks its complete integrity, source digests, exact exported object references,
runtime method table and descriptors, and authorization hash. A different object with an
identical descriptor is rejected. The source digest includes the referenced DTO declaration.
The shared Vite/Rolldown pass injects this association into the actual Plugin output;
Host preserves the candidate's site and Command identities through graph admission.

The versioned authorization hash includes publisher identity, API ID, method names and
Command bindings, wire schema constraints and defaults, Result success types, and protocol
version. It removes presentation annotations only at schema positions. A business property
named `description`, its default, and a `description` key inside `const` remain significant.

| Change                                             | Old artifact binds? | Authorization hash | Fresh artifact                  |
| -------------------------------------------------- | ------------------- | ------------------ | ------------------------------- |
| Command binding or method table                    | No                  | Changes            | Required                        |
| Wire input or success DTO                          | No                  | Changes            | Required                        |
| Implementation with identical descriptor and types | No                  | Stable             | Required                        |
| Command and field description only                 | No                  | Stable             | Required; contains updated text |

The authorization hash describes the approved interface, not implementation behavior.
An implementation-only change remains the publisher's responsibility. A description-only
change refreshes the full artifact while retaining the approved interface hash.

## Remaining scope

- The shared pipeline currently handles one packed source package and a direct
  `ctx.require(Rpc).publish({ id, commands })` site. Host tests cover fixed, dynamic, HMR,
  rejected-candidate, and disabled-service paths; this production probe covers a generated
  packed-source publication through the real Host service. JS/declaration-only Command
  packages still need a separate build-time descriptor artifact before they can participate.
- Production generation needs bounded coverage for all admitted TypeScript and TypeBox schema
  forms, explicit rejection of unsupported native objects, and stable diagnostics. The
  declaration is a client promise, not an output validator.
- The hash implementation tests the schema keywords used here. Production code needs a
  versioned, audited canonicalizer for every supported schema keyword, reference, default,
  and wire Transform, plus package identity derived from the build graph rather than the
  fixture constant.
- The artifact's unkeyed digest detects accidental mismatch within a trusted package. It is
  not an authenticity signature against a party that can rewrite both code and artifact.
  Session authorization is the trusted application's decision and must persist exact hashes.
- This experiment does not exercise sandboxing, Cap'n Web, HTTP transport lifecycle, or
  isolated code execution. Those have separate internal probes and are not public here.

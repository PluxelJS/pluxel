# Commands implementation

Public contract and examples live in [README.md](../README.md). The package owns validated command execution and catalog facts; carriers own authorization, protocol shape and presentation.

## One compiled authority

```text
author schema → clone / normalize / reference and default checks
              → CompiledSchema: frozen JSON projection + validators + codec
command metadata + compiled schemas → immutable descriptor and execution plan
```

Cache the whole CompiledSchema by author schema identity. The first compilation captures schema contents; later mutation is not observed. `compileCommand()` checks metadata and examples; `defineCommand()` captures custom validators and handler around that plan. Never build separate descriptor and validator normalization paths.

Clone caller metadata before freezing. Descriptors, catalog snapshots and registration handles are frozen; executable commands and errors remain ordinary objects. Strict JSON checks run at every wire boundary, including Any/Unknown, not during route matching. Defaults apply only to input; examples validate wire data without executing codecs.

Input Decode failures retain deliberately thrown structured INPUT_VALIDATION errors; other failures expose safe generic issues with diagnostic causes. Handler and validator values use decoded types; public calls and carriers use encoded wire types. No unchecked execution callback is exposed.

## Catalog and lifetime

- One registry owns name conflicts, revision, snapshots and subscriptions. Snapshot identity remains stable until successful mutation.
- Notifications run synchronously in revision order; reentrant changes queue, listener failures remain isolated, subscription has no eager initial emission.
- Registration is a branded live handle. Schema compatibility compares name and recursively canonicalized input/output schemas; presentation and behavior may change independently.
- DirectCommand excludes installed handles and lifecycle disposal at the type boundary. It is not authenticity proof; adapters still validate runtime objects and preserve captured execute receiver semantics.
- Registry withdrawal affects future lookup, not admitted calls. Plugin generation admission/drain belongs to Services; root publication and carrier mount are separate.
- Per-call Context never becomes mutable registry state. Preserve context variance and receiver-independent callable capabilities when projecting cancellation/deadline fields.

## Argv ownership

| Module        | Responsibility                                                                 |
| ------------- | ------------------------------------------------------------------------------ |
| `compile.ts`  | Schema-derived immutable binding, help descriptor and validation               |
| `tokenize.ts` | Raw text tokens and source spans; shell arrays retain existing boundaries      |
| `parse.ts`    | Untrusted candidate object                                                     |
| `router.ts`   | Trie registration, longest-prefix lookup, revision-cached listing and disposal |

Binding checks all routes before mutation; disposal prunes affected nodes. Positionals consume one token; tail ends structural parsing. Both feed the same command execution boundary. DSLs belong in a field codec, not a second argv parser. Suggestions run only on failure and never change successful resolution.

External CLI frameworks and provider SDKs may consume filtered descriptors; their options, environments and completion formats do not become command schema or kernel dependencies.

## Validation and performance

Cover definition errors, strict JSON/defaults/references, codecs, expected/fault errors, cancellation/deadline stages, registration replacement/withdrawal, reentrant subscription order and argv ambiguities. Preserve inferred direct output and unknown dynamic output.

`pnpm --filter @pluxel/commands bench` measures compilation, direct/registry execution, payload scaling, cached catalog reads, DSL decoding and argv routing at several catalog sizes. Results are same-machine evidence, not portable thresholds. Improve measured bottlenecks without adding provider protocols or Plugin lifecycle to this package.

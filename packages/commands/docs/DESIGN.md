# Commands Architecture

`@pluxel/commands` has one authority for identity, description, structure, behavior, and execution.
Carriers project that authority; they do not recreate it.

```text
CommandDescriptor (JSON facts) ----------------> discovery and carrier projection

Agent / HTTP JSON --------------------\
argv syntax -> candidate object -------> Command wire input object
registry / direct call ---------------/             |
                                                     v
                                      validate -> Transform Decode
                                                     |
                                                     v
                                                  handler
                                                     |
                                                     v
                                      Transform Encode -> validate
```

The object-root Command input is the only argument authority. An argv binding maps routes and tokens
to its existing fields; it cannot add a second input contract. A string-backed Transform gives one
field domain meaning regardless of whether its wire string came from an option, positional, text
tail, Agent, HTTP, registry, or direct execution. ParseBox therefore belongs inside such a Transform,
not in the argv router.

## Public contract

The descriptor is deliberately flat:

```ts
type CommandDescriptor = {
	name: string
	title?: string
	description: string
	behavior: CommandBehavior
	inputSchema: JsonSchema
	outputSchema?: JsonSchema
	examples?: readonly CommandExample[]
}
```

- `name` is the stable registry and invocation identity. It follows the portable MCP tool-name
  character set and length.
- `title` is optional presentation, not identity.
- `description` is the semantic selection text for humans and models.
- `behavior` is a consistent discriminated model rather than loosely related optional booleans.
- input and declared output schemas are plain JSON with TypeBox runtime symbols removed.
- `examples` are optional schema-checked input/output data, never carrier command strings.

Descriptors and projections are immutable snapshots in both their types and runtime behavior.
Compilation clones author-owned metadata before freezing, so defining a command never freezes the
caller's configuration objects.

Runtime freezing is limited to descriptor and catalog snapshots whose stable identity backs caches.
The executable `Command`, caller configuration, errors, and registration handles remain ordinary
objects; they do not need snapshot semantics.

There is no `id`/`doc`/`schemas` nesting because those containers add traversal without expressing a
domain boundary.

`description` remains selection text, not an untyped container for examples. Field-level examples
stay in JSON Schema; whole-command examples stay in `examples`. A carrier without a native example
field decides whether and how to present them, while the core preserves the canonical description.

## Behavior and external annotations

Behavior describes the worst case for one command:

```ts
type CommandBehavior =
	| { kind: 'query'; world: 'closed' | 'open' }
	| {
			kind: 'mutation'
			destructive: boolean
			idempotent: boolean
			world: 'closed' | 'open'
	  }
```

It deterministically projects to `readOnlyHint`, `destructiveHint`, `idempotentHint`, and
`openWorldHint`. Permissions and confirmation are decisions made using these facts plus a trusted
principal and host policy; they are not descriptor fields.

Commands with argument-dependent danger use their maximum danger. Prefer separate commands when two
invocations have materially different authorization or confirmation requirements.

## Execution boundary

`execute()` is result-shaped; `executeOrThrow()` runs the identical validated pipeline and throws a
structured error. The author callback is captured and never exposed. This prevents internal
adapters from turning a typed implementation function into an accidental unvalidated public API.

Context is passed per call. No registry or adapter stores mutable current Context, principal, or
owner identity.

Registries and argv routers preserve their `CommandContext` requirement. A carrier-specific context
may extend the base context and accept portable base-context commands, but a base registry cannot
safely accept a command requiring carrier-only fields. Adapters must preserve this variance rather
than erase it with `AnyCommand<any>` or an optional-field union of every carrier context.

## One registry

`CommandRegistry` is the only stateful catalog. Tool conversion is a cached pure function over its
descriptor list. This avoids duplicate registration, cleanup, revision, naming, and conflict rules.

The public package uses factories rather than public constructors. `createCommandRegistry()` and
`createArgvRouter()` construct the stateful catalog and custom router primitives;
`createCommandArgv()` constructs the lazy catalog adapter. Class names remain type-only exports.
This preserves useful annotations without offering parallel `new` and factory styles or implying
subclass extension points.

Carrier-specific names require an adapter-owned reversible map. They do not rename the underlying
command.

## Default catalog argv projection

`createCommandArgv(catalog)` provides conservative CLI availability without requiring each command
owner to repeat `bind()` metadata. The exact first token selects `CommandDescriptor.name`; remaining
schema fields use generated named options, with complex fields opting into the existing field-level
JSON parser. It does not guess positionals, aliases, tails, or a whole-input JSON protocol.

The adapter looks up only the selected current command and compiles one single-command router lazily.
A `WeakMap` keyed by executable command identity retains that router while the handle is current;
replacement naturally receives a new parser without catalog revisions, subscriptions, a mirrored
registry, or a catalog-wide route trie. Parsed candidates dispatch back through
`catalog.executeOrThrow(name, ...)`, so cached handles never bypass current ownership or replacement
policy. Hosts remain responsible for filtering, authorization, confirmation, rendering, and process
behavior.

## JSON Schema and argv

Commands require an object-root input schema and, when output is declared, an object-root output
schema. Every structured contract can therefore become an Agent tool without a wrapper convention.
A command with no business result returns `CommandResult<void>` and omits `outputSchema`. This uses
the existing result and carrier error channel instead of duplicating success as a payload object.

The public `Type` helper is TypeBox's JSON builder, not its JavaScript builder. Definition rejects
JavaScript-only wire schemas at runtime. A JSON-backed TypeBox Transform is a private codec:

```text
wire input -> validate -> Decode -> handler -> Encode -> validate -> wire output
```

Handler validators and implementations use `StaticDecode<S>` values; examples, descriptors,
command results, and carriers use `StaticEncode<S>` values. Transform symbols and functions are
removed from the JSON descriptor. Definition validates examples without executing codecs.

A stable domain DSL follows the same codec rule: its wire value is one annotated string, a
ParseBox-backed Transform decodes it once, and the handler receives the mapping product. Agent,
argv, HTTP, registry, and direct calls therefore share one language instead of publishing a second
AST contract. The Transform's Encode side is a real normalizing printer, preserving the codec
contract when the domain already owns one. A parser-only DSL instead retains its original source
beside the mapping product and encodes back to that source; commands does not require authors to
build a formatter solely to satisfy an input codec.

TypeBox wraps errors thrown by Transform callbacks. An input Decode callback may deliberately throw
an `INPUT_VALIDATION` `CommandError`; the command boundary unwraps and preserves that error so a DSL
can return an actionable path, stable issue code, and safe message to an Agent. Other Decode failures
remain generic `codec_decode` issues with diagnostic causes.

Direct `Date`, `BigInt`, function, or byte-array schemas remain invalid because JSON Schema and JSON
values cannot represent those types honestly. Authors encode them as strings or numbers underneath
a Transform. Codec failures stay on the relevant input/output validation boundary.

Schema references must be self-contained descriptor facts. `Type.Module().Import()` embeds `$defs`
and is supported; a standalone `Type.Ref(schema)` is rejected as `unresolved_reference` because its
target is not present in the command schema, compiled validator, or carrier projection.

## Definition compilation

Each author schema identity compiles into one immutable `CompiledSchema`:

```text
author TypeBox schema
  -> clone + strict-object normalization
  -> portable/reference/default checks
  -> frozen JSON Schema projection
  -> TypeBox validator + Transform codec
  -> CompiledSchema { jsonSchema, validateInput, validateOutput, decode, encode }
```

The complete artifact is cached by author schema identity. Descriptor construction and command
execution receive that artifact explicitly; they do not coordinate through separate normalization
and validator caches. Reusing one schema for input, output, examples, or multiple commands therefore
reuses exactly the same compiled facts. Schema objects are declarative definitions: the first
compilation captures their value, and later mutation of the author object is not observed.

`compileCommand()` validates command metadata and examples against its input/output
`CompiledSchema`s, then returns the final frozen descriptor and both compiled schemas as one
immutable plan. `defineCommand()` only captures custom validators and the implementation around that
plan; it does not compile or project schemas independently.

Every wire value is cloned and checked as strict JSON before schema validation, including values
accepted by `Any` and `Unknown`. This rejects JavaScript values that JSON serialization would throw
on, coerce, or silently discard. Declared defaults apply to input normalization only. Output and
output examples are validated exactly as produced so handler omissions remain visible faults.
Defaults are schema-checked at definition time because the runtime actively applies them; an invalid
default is therefore author configuration failure, not caller input failure.

JSON Schema does not define argv syntax. Nested objects, unions, tuples, and references have no
honest automatic positional representation. The argv adapter handles a closed scalar subset and
requires explicit positional or JSON bindings for everything else. Unsupported mappings fail during
binding. Help exposes one canonical kebab-case option name, while input matching is case-insensitive
and treats underscores as hyphens. Explicit aliases are reserved for short names and genuinely
different spellings rather than cosmetic variants. Help derives closed string choices and strict
JSON defaults from the same field schemas instead of maintaining parallel metadata.

The router accepts either raw command text or argv tokens already split by a shell/runtime. Text is
tokenized once; token arrays retain argument boundaries directly, including one argument containing
spaces. Both forms enter the same route match, coercion, and command validation implementation.

Binding syntax has four non-overlapping responsibilities: routes select the command, positionals
reserve ordered fields, `options` customizes generated options, and tail owns remaining source.
`options` is deliberately an override map rather than an allowlist; unlisted scalar fields still
derive options from the command schema. Positionals, fixed tail fields, and option overrides are
mutually exclusive at binding time. There is no parallel argv argument schema.

Positionals consume one token each and allow option parsing to continue. Tail consumes all remaining
source into one field and ends structural argv parsing, so it is a distinct terminal operation rather
than a variadic positional disguised with extra ordering rules. Tail is optional and does not impose
a two-stage grammar on bindings that do not need free text, a primary DSL, or a whole JSON remainder.

Options may occur before or after positionals until tail consumption begins. `--` only disables
option recognition: pending positionals are consumed normally, then any remainder enters the tail.
Duplicate scalars fail, repeated arrays accumulate, and grouped short aliases are accepted only when
all members are boolean. Once a tail begins, later option-looking text belongs to that tail; this
keeps natural grammars deterministic and `--` available when a hyphen-leading positional is needed.
Long-option parsing checks an exact name before treating `no-` as boolean negation, so a genuine
`no-cache` field and the `cache=false` shorthand remain deterministic.

Unknown option, route, and closed-choice suggestions are deterministic facts over the current argv
binding. They are computed only on failed input, capped at three close values, and never affect the
successful parse path. Core registry lookup does not suggest names because authorization-aware
catalog filtering belongs to the host.

Text tails assign the remaining source to one string field without interpreting it. A shared domain
DSL can decode that string through its application-owned Transform; ungrammatical prose stays plain
text. Raw text preserves the original tail substring apart from outer whitespace, while
pre-tokenized argv is reconstructed with single spaces because the shell has already consumed quote
syntax. ParseBox is not an argv extension point: this keeps one validation path and avoids a
carrier-only patch contract with no real consumer.

The text-tail key is contextually restricted to string wire fields; this includes Transforms backed
by a string schema and excludes decoded-only domain types from the argv contract. JSON tails remain
available for any JSON wire field. Binding repeats the string-schema check at runtime for untyped
callers.

A transformed DSL string may also use an ordinary generated option. Options are preferable for
named or reorderable expressions and consume one already-quoted shell token; text tails are
preferable for an unquoted primary remainder. This is a carrier usability choice only. Both produce
the same wire string and enter the same Transform exactly once.

## Performance

- The complete `CompiledSchema` projection, validators, and codec compile once per schema identity.
- Final command descriptors and examples are normalized and frozen once by `compileCommand()`.
- Registry lookup is `Map`-based; locale-independent sorted descriptor lists are revision-cached.
- Tool projections cache frozen command descriptor/list identities. Mutable external descriptors
  are cloned and are never frozen or cached by the projection.
- Argv routes compile into a trie and dispatch tokenizes once. Shared DSL Transforms decode once
  inside normal command validation.
- Argv help resolves command names by `Map` and exact routes by the same trie; catalog size does not
  change successful lookup complexity.
- Argv binding checks every new route before mutating the trie; disposal removes its routes and
  prunes empty nodes without rebuilding unrelated entries.
- Approximate suggestions run only after an unknown route, option, or closed choice.
- JSON wire checks are linear in payload size and do not run during route matching or discovery.

`pnpm --filter @pluxel/commands bench` measures definition, text and pre-tokenized execution, cached
discovery, shared ParseBox DSL decoding, route and help scaling, and catalog construction at 10,
100, and 1,000 commands through Vitest's Tinybench integration. Benchmark results are same-machine
evidence, not portable correctness thresholds.

Ordinary route matching stays in JavaScript. A native matcher is justified only by measured large
multi-pattern workloads and should batch raw UTF-8 data rather than callback across N-API per match.

## CLI ecosystem boundaries

[`usage`](https://usage.jdx.dev/spec/) is a useful future projection target, not an argv parser. A
standalone CLI host that needs shell completion, manpages, Markdown, or SDK generation can project
`ArgvCommandDescriptor` catalogs into Usage KDL without changing command execution. The projection
must remain host-owned because binary metadata, global flags, environment/config precedence, hidden
commands, and command mounting are host facts. `CommandBehavior` can conservatively map query to
`read`, destructive mutation to `destructive`, and other mutation to `write`; `world` and
`idempotent` have no lossless Usage equivalent.

[`args-tokens`](https://github.com/kazupon/args-tokens) tokenizes argv arrays and resolves a separate
option schema. It does not replace raw message tokenization with source spans, route matching,
schema-derived bindings, text/JSON tails, or the shared Command validation pipeline. Successful argv
dispatch is already measured in the low-microsecond range, so adding it to core currently has no
demonstrated correctness or performance benefit.

[`gunshi`](https://github.com/kazupon/gunshi) is a complete CLI framework with its own command,
argument, context, plugin, and rendering model. It may be used by a host that deliberately adapts a
filtered commands catalog, but core must not depend on it or recreate command definitions in it.

Argv internals follow these ownership boundaries: `compile.ts` derives immutable bindings and help,
`parse.ts` constructs an untrusted candidate, `tokenize.ts` preserves raw text spans, and `router.ts`
owns trie registration and dispatch.

## Non-goals

The package does not own:

- a process-global registry;
- plugin lifecycle implementation or host startup policy;
- authentication, authorization, confirmation, rate limiting, or audit storage;
- an Agent provider SDK, MCP server, HTTP server, shell, or UI;
- task polling/retention semantics;
- arbitrary JSON Schema-to-CLI projection.

Runtime commands delegate to existing lifecycle use cases. They do not duplicate core graph commit,
start, stop, restart, or rollback behavior.

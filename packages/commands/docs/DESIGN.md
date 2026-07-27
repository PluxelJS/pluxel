# Commands Architecture

`@pluxel/commands` has one authority for identity, description, structure, behavior, and execution.
Carriers project that authority; they do not recreate it.

```text
CommandDescriptor (JSON facts) --------> Agent/MCP projection
              |                         HTTP/Workbench discovery
              |                         generated docs
              |
unknown input + call-scoped context
              v
       Command.execute()
              |
 input -> custom validation -> handler -> output validation
```

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

## One registry

`CommandRegistry` is the only stateful catalog. Tool conversion is a cached pure function over its
descriptor list. This avoids duplicate registration, cleanup, revision, naming, and conflict rules.

The public runtime exposes `createCommandRegistry()` and `createArgvRouter()` as the sole
construction functions. Their class names are type-only exports. This preserves useful annotations
without offering parallel `new` and factory styles or implying subclass extension points.

Carrier-specific names require an adapter-owned reversible map. They do not rename the underlying
command.

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

Options may occur before or after positionals until tail consumption begins. `--` only disables
option recognition: pending positionals are consumed normally, then any remainder enters the tail.
Duplicate scalars fail, repeated arrays accumulate, and grouped short aliases are accepted only when
all members are boolean. Once a tail begins, later option-looking text belongs to that tail; this
keeps natural grammars deterministic and `--` available when a hyphen-leading positional is needed.

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

- TypeBox validators compile once and are cached by schema identity.
- JSON descriptors are normalized and frozen once.
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

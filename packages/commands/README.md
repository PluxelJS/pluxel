# @pluxel/commands

Define a capability once, validate every call, and project it into Agent tools, argv/message
commands, HTTP, or another host-owned carrier.

## The whole model

```ts
import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

export const jobStatus = defineCommand({
	name: 'job.status.get',
	description: 'Read the current status of one job.',
	behavior: { kind: 'query', world: 'closed' },
	input: obj({
		jobId: Type.String({ description: 'Stable job identifier.', examples: ['cache-refresh'] }),
	}),
	output: obj({
		status: Type.Union([Type.Literal('running'), Type.Literal('stopped'), Type.Literal('failed')]),
	}),
	examples: [
		{
			title: 'Running job',
			input: { jobId: 'cache-refresh' },
			output: { status: 'running' },
		},
	],
	async execute({ jobId }, context) {
		context.signal?.throwIfAborted()
		return { status: await readJobStatus(jobId) }
	},
})
```

Every field has one job:

| Field         | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `name`        | Stable, case-sensitive machine name used by registries and tool calls. |
| `title`       | Optional short display label.                                          |
| `description` | What the command does, written for humans and models.                  |
| `behavior`    | Static worst-case side effects for discovery and confirmation policy.  |
| `input`       | JSON object accepted at every untrusted boundary.                      |
| `output`      | Optional JSON object returned to structured consumers.                 |
| `examples`    | Optional transport-neutral input/output cases.                         |
| `execute`     | Typed implementation captured inside the validated command.            |

There is no descriptor version, nested `doc`, transport metadata, or second unchecked execution
method.

## One input contract, three layers

The Command input object is the only public argument contract. Carrier syntax and domain decoding
are projections around it, not additional schemas:

```text
argv route/options/positionals/tail --\
Agent or HTTP JSON -------------------> wire input object
direct or registry call -------------/         |
                                                 v
                                  defaults + validation + Transform Decode
                                                 |
                                                 v
                                      decoded values for execute()
```

Each layer answers one different question:

| Layer         | Owns                                                              | Does not own                      |
| ------------- | ----------------------------------------------------------------- | --------------------------------- |
| Carrier       | How transport input reaches fields in the input object            | Field meaning or business parsing |
| Command input | JSON shape, defaults, validation, and string-backed domain codecs | CLI routes, quoting, or aliases   |
| Handler       | Business behavior over decoded values                             | Untrusted transport parsing       |

For example, argv may place `--condition "players >= 30"` into
`{ condition: 'players >= 30' }`. A ParseBox-backed `Type.Transform(Type.String())` on the
`condition` field then decodes that string before `execute()`. The same Transform runs when the
string comes from a positional, `tail.text()`, Agent JSON, HTTP, or a registry call. ParseBox is not
an argv parser, and ordinary string fields are not parsed unless their schema explicitly defines a
Transform.

With `tail.text('content')`, input such as
`--condition "players >= 30" -- notify moderators` first becomes
`{ condition: 'players >= 30', content: 'notify moderators' }`. Only fields whose input schema has a
Transform are domain-decoded; `content` remains a normal string unless it declares its own codec.

`Type` is the JSON TypeBox builder. Commands reject schemas whose wire values are JavaScript-only,
such as `Type.Function()`, `Type.Date()`, `Type.BigInt()`, and byte arrays. JSON Schema has no such
types: dates serialize as strings without preserving their class, BigInt cannot be serialized by
JSON, and functions have no JSON representation.

Object properties are closed by default, including nested `Type.Object()` schemas. Use `openObj()`
only where arbitrary extra JSON properties are part of the public contract.

Schema references must be self-contained because descriptors travel without a TypeBox reference
registry. Use `Type.Module().Import()` when a schema needs reusable definitions:

```ts
const Models = Type.Module({
	Resource: Type.Object({ id: Type.String() }),
})

const input = obj({ resource: Models.Import('Resource') })
```

A standalone `Type.Ref(schema)` is rejected with `COMMAND_CONFIG` reason `unresolved_reference`;
the referenced schema is not embedded in either the compiled validator or published descriptor.

Use a JSON-backed `Type.Transform()` when the implementation benefits from a domain value:

```ts
const BigInteger = Type.Transform(Type.String({ pattern: '^-?\\d+$' }))
	.Decode((value) => BigInt(value))
	.Encode((value) => String(value))

const Timestamp = Type.Transform(Type.String())
	.Decode((value) => new Date(value))
	.Encode((value) => value.toISOString())
```

The underlying strings remain the public schema and example format. Transform functions stay
private beside `execute`: input is decoded before custom validation and execution, and handler
output is encoded before output validation and return. Direct command callers, Agent tools, CLI,
and HTTP adapters therefore all observe the same JSON wire contract.

Wire values are checked as actual JSON even under `Type.Any()` or `Type.Unknown()`. Functions,
BigInt, class instances, non-finite numbers, sparse arrays, cycles, accessors, and symbol properties
fail validation instead of being coerced or silently dropped. Transform-decoded domain values are
not subject to this restriction inside validators and `execute`.

## Keep descriptions semantic and examples structured

`description` tells a human or model what the command does, when it is appropriate, and any
important constraint that the schemas cannot express. It does not contain argv syntax, JSON blobs,
or an examples section.

Use JSON Schema annotations for one field's meaning and representative values. Use command
`examples` for complete, transport-neutral calls:

```ts
input: obj({
	jobId: Type.String({
		description: 'Stable job identifier.',
		examples: ['cache-refresh'],
	}),
}),
examples: [
	{
		title: 'Running job',
		input: { jobId: 'cache-refresh' },
		output: { status: 'running' },
	},
]
```

Examples are schema-checked when the command is defined, their inputs receive declared defaults,
and the normalized JSON is frozen in `CommandDescriptor.examples`. Example outputs are checked as
written; output defaults never invent handler results. An argv example such as
`job status cache-refresh` belongs beside the argv binding or in carrier documentation because
routes, quoting, and aliases are not command semantics.

MCP currently has no standard structured tool-example field. The core therefore never appends
examples to `description`; a provider bridge can consume `CommandDescriptor.examples` according to
that provider's capabilities without changing the canonical description.

## Install

```sh
pnpm add @pluxel/commands
```

## Execute safely

```ts
const output = await jobStatus.execute({ jobId: 'cache-refresh' }, context)
```

`execute()` is the only execution contract. It validates and normalizes input, runs custom
validation, executes the typed handler, validates declared output, and throws `CommandError` on
failure. Carriers catch that error once at their transport boundary.

The original typed `execute` callback is not exposed on the returned object, so an adapter cannot
accidentally call it with untrusted input.

`context.signal` is the cooperative cancellation channel. `deadlineMs` is an absolute Unix
timestamp checked between pipeline stages and before returning; it does not pretend to interrupt
work that ignores the signal. Carriers that require hard request deadlines should abort the signal
and make their IO operations observe it.

The base `CommandContext` may be omitted. When a host extends it with required request-scoped
fields, the command, registry, and argv APIs require that context at the call site.
An extended context is a per-invocation capability record: callable fields should be closure-safe
and must not depend on the context object as their `this` receiver, because hosts may project the
record when composing cancellation and deadline facts.

## Omit output when success has no business value

Commands that only need to report success or failure do not declare an output schema:

```ts
const clearCache = defineCommand({
	name: 'cache.clear',
	description: 'Clear one cache.',
	behavior: { kind: 'mutation', destructive: true, idempotent: true, world: 'closed' },
	input: obj({ name: Type.String() }),
	async execute({ name }) {
		await caches.clear(name)
	},
})
```

`clearCache.execute()` resolves `undefined`, and the descriptor omits `outputSchema`. The carrier's
error channel already represents failure, so the package does not add a redundant `{ ok: true }`
payload. If callers
need facts such as `changed`, `status`, or an identifier, declare `output` explicitly. Returning an
undeclared value is an `OUTPUT_VALIDATION` fault rather than being silently discarded.

## Describe behavior honestly

A query does not modify its environment:

```ts
behavior: { kind: 'query', world: 'closed' }
```

A mutation must answer every safety-relevant question:

```ts
behavior: {
	kind: 'mutation',
	destructive: false,
	idempotent: true,
	world: 'closed',
}
```

- `destructive`: may delete or irreversibly overwrite state;
- `idempotent`: repeating the same call has no additional effect;
- `world: 'open'`: may interact with external entities such as the public web or third-party APIs;
- `world: 'closed'`: acts only on a bounded local/application domain.

`behavior` is a static worst-case description, not permission. If one flag changes a read command
into a destructive command, prefer two commands. When that is impossible, describe the command by
its most dangerous possible invocation.

The discriminated union prevents meaningless states such as a read-only destructive command. It
maps without loss to common Agent/MCP annotations.

## Use one registry as the catalog

```ts
import { createCommandRegistry } from '@pluxel/commands'

const commands = createCommandRegistry()
const registration = commands.register(jobStatus)

commands.list() // the current snapshot's frozen CommandDescriptor[]
commands.snapshot() // { revision, descriptors }, identity-stable until the next mutation
await commands.execute('job.status.get', { jobId: 'cache-refresh' }, context)

registration.dispose() // idempotent
```

`createCommandRegistry()` is the only runtime construction entry. Import `CommandRegistry` with
`import type` when an annotation is needed; the implementation class is not a public constructor or
subclassing surface.

The registry is the only command catalog and the only authority for revision, snapshots, and
publication subscriptions. `subscribe(listener)` observes later successful registrations and
withdrawals; it does not emit an initial snapshot, and its returned disposer is idempotent.
Notifications run synchronously in revision order, including reentrant mutations, and one listener
failure cannot fail the mutation or skip other listeners.

Lookup by a runtime string cannot infer a particular output type, so registry execution and the
command returned by argv resolution produce `unknown`. Call the original `Command` object when
application code needs statically inferred output; validate or narrow dynamic output in a carrier.

`register()` returns a typed `CommandRegistration`: it is both the idempotent disposer and a branded
live `InstalledCommand`. The installed handle resolves its name on every call. After a compatible
replacement it invokes the new implementation; after withdrawal or an incompatible replacement it
fails closed with `COMMAND_NOT_FOUND`. Compatibility contains only `name`, `inputSchema`, and
`outputSchema`, serialized with canonical object-key order. Presentation, behavior, and examples may
change without invalidating a typed handle. Disposal does not cancel calls that already started.

Carrier packages that must retain one concrete implementation should accept `DirectCommand` rather
than `Command`. Commands returned by `defineCommand()` and ordinary hand-authored command objects are
assignable to it, while `InstalledCommand` and `CommandRegistration` are rejected because their
`execute()` follows compatible catalog replacement. A direct definition is lifecycle-neutral and cannot
also expose `dispose`. This is a type-level misuse guard, not a trust or security boundary; JavaScript
carrier entry points must still validate received objects.

`@pluxel/runtime` provides root-catalog ownership through `ctx.commands.register(command)`. Carrier
providers that need a generation-pinned route or SDK publication use
`ctx.commands.createMount<CarrierContext>()` and bind a `DirectCommand`; a registry-installed handle
must not become that route's identity. Runtime holds the relevant owner admission while execution
settles. Core closes the generation gate, aborts the combined owner/call signal, and drains admitted
invocations before effects cleanup. Direct registry construction remains lifecycle-neutral for
standalone hosts and provider-private name discovery. Manually disposing one publication withdraws
future lookup and does not cancel a call that already started or close sibling command admission.

Agent/MCP, HTTP, and other protocol projections belong to the carrier. They consume filtered command
descriptors, map the current provider protocol, retain any reverse name mapping, and dispatch back
through the authorized catalog. The kernel does not freeze one provider's tool shape or task model.

## Add custom argv or message syntax

```ts
import { createArgvRouter } from '@pluxel/commands/argv'

const argv = createArgvRouter()
argv.bind(jobStatus, {
	routes: ['job status', 'status'],
	positionals: ['jobId'],
})

const resolution = argv.resolve('job status cache-refresh')
// { command, route: 'job status', candidate: { jobId: 'cache-refresh' } }
if (resolution) await resolution.command.execute(resolution.candidate, context)

// A real CLI already has token boundaries. Pass them through without joining them back into text.
const shellResolution = argv.resolve(process.argv.slice(2))
if (shellResolution) await shellResolution.command.execute(shellResolution.candidate, context)
```

`createArgvRouter()` is likewise the only runtime construction entry. `ArgvRouter` remains available
as a type, not as a second `new ArgvRouter()` construction style.

A router is heterogeneous by default, so a dynamically resolved command returns `unknown`. When a
carrier deliberately binds only commands with one shared output contract, preserve that fact with
`createArgvRouter<MyContext, MyOutput>()`; `bind()` then rejects commands with incompatible outputs.

The first route is canonical; the rest are aliases. Binding compiles routes into a longest-prefix
trie. Resolution tokenizes once and constructs an untrusted candidate object. The host then decides
whether and when to execute the resolved command through its normal validated boundary.

```text
Command input schema + explicit ArgvBinding
  -> compiled route, positionals, scalar options, choices, and defaults
  -> tokenize and longest-route match
  -> coerce argv values into an untrusted candidate object
  -> Command.execute(candidate, context)
  -> the same defaults, Decode, validation, handler, Encode, and output validation as every carrier
```

The router does not create a second command implementation or validation path. It only translates
text or pre-tokenized argv into the command's JSON input boundary. Raw strings are tokenized once
for chat and message commands; `readonly string[]` preserves the token boundaries already produced
by a shell, Node, Bun, or another CLI host. Do not reconstruct those tokens with `join(' ')` first.

One router accepts one active binding per command name. Dispose the prior registration before
binding that command again.

Routes use a canonical lowercase grammar. Matching is case-insensitive by default; set
`caseInsensitive: false` when uppercase input should be rejected. Command text is limited to 16 KiB
by default, and `maxTextLength` must be a positive safe integer.

An `ArgvBinding` only maps existing input-object fields into carrier syntax:

| Binding       | Consumption                                                                   | Use it for                                               |
| ------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| `routes`      | Selects the command; first route is canonical, the rest are aliases           | Human-facing command paths                               |
| `options`     | Named, reorderable values; unlisted scalar fields still get generated options | Optional or easily confused values, names, short aliases |
| `positionals` | One argv token per field, in declared order                                   | One or two obvious required values such as an ID or name |
| `tail`        | One field consumes all remaining source as text or one JSON value             | Free text, a primary DSL expression, or a payload        |

Positionals and tail stay separate because they terminate parsing differently: a positional consumes
one token and normal option parsing continues, while tail consumes the remainder and later
option-looking text belongs to that field. This does not force every command into two sections.
Without a tail there is no remainder phase; with one, options and positionals may still interleave
until tail consumption begins. `--` explicitly stops option recognition, fills any pending
positionals, and then sends the remainder to tail.

`tail.text(key)` contextually suggests only string wire fields from the bound Command, including a
DSL field whose `Type.Transform()` is backed by `Type.String()`. `tail.json(key)` accepts any command
field and parses the entire remainder as one JSON value before normal schema validation. Both accept
an optional help placeholder as their second argument. Untyped attempts to bind a text tail to a
non-string schema fail immediately during `bind()`.

After explicit positionals and a text/JSON tail key are reserved, every remaining top-level
scalar schema field becomes an option. `options` changes its public name, aliases, description, or
JSON format. Fields omitted from `options` still receive their generated option, so CLI syntax never
becomes a second schema declaration. A positional or tail field cannot also appear
in `options`; conflicting bindings fail immediately instead of silently ignoring one declaration.

Top-level string, number, integer, boolean, string-enum, and scalar-array fields can become options.
Each option has one canonical kebab-case long name, which is what help output displays. Option
matching is case-insensitive and treats `_` like `-`, so `--retry-count`, `--RETRY-COUNT`, and
`--retry_count` address the same option. Use explicit `aliases` for short names or genuinely
different spellings. Positionals are explicit. In a custom binding, complex schemas must opt into
JSON decoding:

```ts
argv.bind(patchConfig, {
	routes: ['settings patch'],
	positionals: ['scope'],
	options: {
		patch: { format: 'json' },
	},
})

const patchResolution = argv.resolve(`settings patch cache --patch '{"enabled":true}'`)
if (patchResolution) {
	await patchResolution.command.execute(patchResolution.candidate, context)
}
```

Unsupported automatic mappings fail at bind time instead of being guessed.

The accepted grammar is deliberately small and conventional:

| Input                                 | Meaning                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `--name value`, `--name=value`        | long option value                                                         |
| `-n value`, `-n=value`                | explicit one-character short alias                                        |
| `--flag`, `--flag=false`, `--no-flag` | boolean forms                                                             |
| `-abc`                                | grouped short aliases only when every member is boolean                   |
| repeated array option                 | append values in encounter order                                          |
| option before or after a positional   | accepted until tail input begins                                          |
| `--`                                  | stop option parsing; remaining positionals are still consumed before tail |

An exact option name wins before boolean negation is considered. If the schema contains a boolean
field named `noCache`, canonical `--no-cache` sets that field to `true`. When there is no exact
`no-cache` option, `--no-cache` remains shorthand for setting boolean `cache` to `false`.

Scalar options may appear before or after positionals. Duplicate scalar options are rejected rather
than silently choosing a winner; repeated array options accumulate. A hyphen-leading positional such
as `-5` should follow `--`. Once all positionals are filled and tail input begins, the remainder
belongs to the tail field, so router options intended for that call must appear before the tail.

`argv.list()` returns frozen data for a host-owned help renderer. Parameter descriptors
include scalar type, required state, aliases, description, closed string `choices`, and the schema's
strict JSON `defaultValue` when present. Generated usage uses typed placeholders such as `<integer>`
and `<json>` without exposing the full schema.

Unknown options include up to three deterministic `suggestions`. Invalid string-enum values report
`allowedValues` and a close value when one exists. Suggestions are computed only after a parse
failure; successful resolution does no fuzzy matching. An unmatched route simply resolves
`undefined`, leaving carrier-specific feedback and catalog filtering to the host.

### Prefer ordinary CLI syntax for ordinary inputs

Use the smallest conventional mapping that expresses the command:

- keep one or two obvious, required values as `positionals`;
- use generated `options` for optional, reorderable, or easily confused values;
- use `tail.text()` after `--` for arbitrary trailing text such as a reason.

For example, a management command does not need a custom grammar:

```ts
const banMember = defineCommand({
	name: 'member.ban',
	description: 'Ban one member.',
	behavior: { kind: 'mutation', destructive: true, idempotent: true, world: 'closed' },
	input: obj({
		member: Type.String(),
		durationMinutes: Type.Optional(Type.Integer()),
		permanent: Type.Optional(Type.Boolean({ default: false })),
		silent: Type.Optional(Type.Boolean({ default: false })),
		reason: Type.Optional(Type.String()),
	}),
	execute: async (input) => {
		// Apply the ban and return no business payload.
	},
})

argv.bind(banMember, {
	routes: ['member ban', 'ban'],
	positionals: ['member'],
	options: {
		durationMinutes: { name: 'duration', aliases: ['t'] },
		permanent: { aliases: ['p'] },
		silent: { aliases: ['s'] },
	},
	tail: tail.text('reason', '[reason]'),
})

const ban = argv.resolve('ban xewx -t 30 -- flooding and repeated abuse')
if (ban) await ban.command.execute(ban.candidate)
// The command receives:
// { member: 'xewx', durationMinutes: 30, permanent: false, silent: false,
//   reason: 'flooding and repeated abuse' }
```

This form keeps meanings visible, permits option reordering, and gives each invalid option a precise
error. ParseBox would add grammar code here without improving the public syntax.

## Decode a shared DSL with ParseBox

The input object remains the authority when a field contains a domain language. Keep that field as
one public string and decode it with the existing `Type.Transform()` boundary. An argv option,
positional, or text tail only decides how the string reaches the field; ParseBox runs later in the
normal Command pipeline. Agent tools, argv, HTTP, registry, and direct callers therefore submit the
same language, while validators and `execute()` receive the ParseBox mapping product. Do not force
Agents to construct a second public AST representation.

Install ParseBox in the application that owns the grammar. It remains optional and is not bundled
with `@pluxel/commands`:

```sh
pnpm add @sinclair/parsebox
```

```ts
import { Runtime } from '@sinclair/parsebox'
import { CommandError, defineCommand, validation } from '@pluxel/commands'
import { createArgvRouter, tail } from '@pluxel/commands/argv'
import { Type, obj } from '@pluxel/commands/typebox'

const Field = Runtime.Union([Runtime.Const('warnings'), Runtime.Const('playtime')])
const Operator = Runtime.Union([
	// ParseBox unions use the first matching branch, so longer prefixes come first.
	Runtime.Const('>='),
	Runtime.Const('<='),
	Runtime.Const('='),
	Runtime.Const('>'),
	Runtime.Const('<'),
])
const PlayerQuery = Runtime.Tuple([Field, Operator, Runtime.Integer()], (values) => ({
	field: values[0],
	operator: values[1],
	threshold: Number(values[2]),
}))

const QueryGrammar = new Runtime.Module({ PlayerQuery })

function invalidPlayerQuery(message: string): never {
	throw new CommandError('INPUT_VALIDATION', 'Invalid command input', {
		details: {
			issues: [validation.constraint('query', message, { code: 'invalid_query' })],
		},
	})
}

function parsePlayerQuery(source: string) {
	const parsed = QueryGrammar.Parse('PlayerQuery', source.endsWith('\n') ? source : `${source}\n`)
	if (parsed.length !== 2) return invalidPlayerQuery('Expected a player filter expression')
	const [query, rest] = parsed
	if (rest.trim()) return invalidPlayerQuery(`Unexpected query input: ${rest.trim()}`)
	return query
}

const PlayerQueryInput = Type.Transform(
	Type.String({
		description:
			'Player filter DSL. Syntax: <field> <operator> <integer>; fields: warnings, playtime; operators: >=, <=, =, >, <.',
		examples: ['warnings >= 3', 'playtime < 10'],
	}),
)
	.Decode((source) => ({ source, expression: parsePlayerQuery(source) }))
	.Encode((decoded) => decoded.source)

const searchPlayers = defineCommand({
	name: 'players.search',
	description: 'Search players with the player filter DSL.',
	behavior: { kind: 'query', world: 'closed' },
	input: obj({
		query: PlayerQueryInput,
		limit: Type.Optional(Type.Integer({ default: 100 })),
	}),
	output: obj({ playerIds: Type.Array(Type.String()) }),
	examples: [{ input: { query: 'warnings >= 3', limit: 25 }, output: { playerIds: [] } }],
	async execute({ query, limit }) {
		// query.expression is ParseBox's typed { field, operator, threshold } mapping product.
		return { playerIds: await findPlayerIds(query.expression, limit) }
	},
})

const cli = createArgvRouter()

cli.bind(searchPlayers, {
	routes: ['players search'],
	options: {
		query: { aliases: ['q'] },
		limit: { aliases: ['l'] },
	},
})

// Agent, HTTP, registry, or direct call: the public value is the DSL string.
await searchPlayers.execute({ query: 'warnings >= 3', limit: 25 })

// A named CLI option carries one quoted shell token into the same Transform.
const cliResolution = cli.resolve('players search --query "warnings >= 3" --limit 25')
if (cliResolution) await cliResolution.command.execute(cliResolution.candidate)

// A message-oriented host may instead make the DSL its unquoted text tail.
const messages = createArgvRouter()
messages.bind(searchPlayers, {
	routes: ['players search'],
	options: { limit: { aliases: ['l'] } },
	tail: tail.text('query', '<filter-expression>'),
})
const messageResolution = messages.resolve('players search --limit 25 -- warnings >= 3')
if (messageResolution) await messageResolution.command.execute(messageResolution.candidate)

// All executions receive:
// query = { source: 'warnings >= 3',
//           expression: { field: 'warnings', operator: '>=', threshold: 3 } }
```

The JSON descriptor exposes `query` as the annotated string, including its grammar description and
examples; Agent providers can project the same schema into their own tool format. Transform
functions stay private. The normal command pipeline validates the wire string, decodes it exactly
once, and turns a parser throw or trailing input into `INPUT_VALIDATION` before `execute()` runs. A
Decode callback may deliberately throw a structured `CommandError('INPUT_VALIDATION', ...)`;
commands preserves its issue path, stable code, and safe message for Agent self-correction.

The decoded value retains the original `source`, so the required `Encode` direction can return it
without forcing a parser-only DSL to implement a second formatter. If the domain already owns a
canonical printer, returning only the expression and using that printer in `Encode` is equally
honest.

The Transform does not care how the wire string arrived. Prefer a string option when the DSL is one
named, reorderable value, when a command has more than one expression, or when shell scripts benefit
from explicit names. Standard options consume one token, so expressions containing spaces must be
quoted by the shell. Prefer `tail.text()` when the expression is the command's primary remainder or
when chat/message users should not need quoting; options must then appear before the tail starts.

For raw command text, `tail.text()` preserves the original substring after the tail begins apart
from trimming its outer whitespace. For a pre-tokenized `process.argv` array, the shell has already
removed quoting and the router reconstructs the tail with single spaces. Using `--` makes the
CLI/DSL boundary explicit but does not invoke ParseBox; the Command Transform performs parsing in
both forms.

ParseBox can technically parse flags, free text, and an entire command line, but that is not a reason
to give it those jobs. Generated options retain schema-derived help, aliases, reordering, defaults,
and precise failures. Ordinary strings such as names, paths, and modes remain normal options or
positionals; ungrammatical prose needs no parser. Use ParseBox only inside a string Transform whose
domain language actually requires parsing, whether that string arrives from an option or a text
tail.

## Validation and errors

JSON Schema validates shape. Custom validators express cross-field constraints:

```ts
import { validation } from '@pluxel/commands'

validate(input) {
	if (input.min > input.max) {
		return validation.constraint('min', 'min must not exceed max')
	}
}
```

The pipeline is:

```text
defineCommand
  -> one cached CompiledSchema per author schema identity
  -> final descriptor + input/output validators + Transform codec

unknown JSON input
  -> strict JSON clone + input defaults + compiled wire validation
  -> Transform Decode
  -> validate decoded input
  -> execute with decoded values
  -> Transform Encode
  -> strict JSON clone + compiled wire validation
  -> validateOutput with decoded output
  -> JSON output
```

Transform decode failures are `INPUT_VALIDATION`; encode failures and invalid handler output are
`OUTPUT_VALIDATION`. Structured examples are wire JSON and never execute codecs during definition.
Schema defaults apply only to input. Because commands use them as runtime values rather than mere
annotations, every declared default is checked against its field schema during `defineCommand()`;
an invalid default is `COMMAND_CONFIG` with reason `invalid_default` and its schema path. Output is
validated exactly as returned, so a missing handler field is never filled implicitly. For commands
without declared output, the pipeline ends after `execute` returns `undefined`.

Stable `CommandError.code` values are for carrier branching. `publicMessage` is presentation-safe;
`message` is diagnostic; `details` carries paths and structured facts. `kind: 'expected'` covers
caller-facing outcomes such as invalid input, denial, cancellation, and timeout. Configuration,
invalid handler output, dependency failure, and internal failure use `kind: 'fault'`.

`cause` is diagnostic and must not be forwarded to an untrusted caller. For example, cancellation
keeps the arbitrary `AbortSignal.reason` as `cause` rather than placing it in public details.

## Public entries

- `@pluxel/commands`: definition, execution, validation, errors, and registry;
- `@pluxel/commands/typebox`: JSON-only TypeBox builder and strict object helpers;
- `@pluxel/commands/argv`: custom route binding, argv resolution, descriptor listing, and text/JSON
  tails.

Repository integration constraints are in [`engineering/COMMANDS.md`](../../engineering/COMMANDS.md); package
implementation invariants and CLI ecosystem decisions are in [`docs/DESIGN.md`](docs/DESIGN.md).

# @pluxel/commands

Define a capability once, validate every call, and project it into Agent tools, argv/message
commands, HTTP, or another host-owned carrier.

## The whole model

```ts
import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

export const pluginStatus = defineCommand({
	name: 'plugin.status.get',
	description: 'Read the current status of one plugin.',
	behavior: { kind: 'query', world: 'closed' },
	input: obj({
		name: Type.String({ description: 'Canonical plugin name.', examples: ['CachePlugin'] }),
	}),
	output: obj({
		status: Type.Union([Type.Literal('running'), Type.Literal('stopped'), Type.Literal('failed')]),
	}),
	examples: [
		{
			title: 'Running plugin',
			input: { name: 'CachePlugin' },
			output: { status: 'running' },
		},
	],
	async execute({ name }, context) {
		context.signal?.throwIfAborted()
		return { status: await readPluginStatus(name) }
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
	name: Type.String({
		description: 'Canonical plugin name.',
		examples: ['CachePlugin'],
	}),
}),
examples: [
	{
		title: 'Running plugin',
		input: { name: 'CachePlugin' },
		output: { status: 'running' },
	},
]
```

Examples are schema-checked when the command is defined, their inputs receive declared defaults,
and the normalized JSON is frozen in `CommandDescriptor.examples`. Example outputs are checked as
written; output defaults never invent handler results. An argv example such as
`plugin status CachePlugin` belongs beside the argv binding or in carrier documentation because
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
const result = await pluginStatus.execute({ name: 'CachePlugin' }, context)
if (result.ok) console.log(result.value.status)
else console.error(result.error.code, result.error.publicMessage)

// For a carrier that already maps CommandError exceptions:
const output = await pluginStatus.executeOrThrow({ name: 'CachePlugin' }, context)
```

Both methods validate and normalize input, run custom validation, execute the typed handler, and
validate declared output. `executeOrThrow` means “same pipeline, throwing result”; it does not bypass
schema validation.

The original typed `execute` callback is not exposed on the returned object, so an adapter cannot
accidentally call it with untrusted input.

`context.signal` is the cooperative cancellation channel. `deadlineMs` is an absolute Unix
timestamp checked between pipeline stages and before returning; it does not pretend to interrupt
work that ignores the signal. Carriers that require hard request deadlines should abort the signal
and make their IO operations observe it.

The base `CommandContext` may be omitted. When a host extends it with required request-scoped
fields, the command, registry, and argv APIs require that context at the call site.

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

`clearCache.execute()` returns `CommandResult<void>` and `executeOrThrow()` resolves `undefined`.
The descriptor and tool projection omit `outputSchema`. Errors already use `CommandResult` and the
carrier's error channel, so the package does not add a redundant `{ ok: true }` payload. If callers
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
const registration = commands.register(pluginStatus)

commands.get('plugin.status.get')
commands.list() // frozen, revision-cached CommandDescriptor[]
await commands.execute('plugin.status.get', { name: 'CachePlugin' }, context)

registration.dispose() // idempotent
```

`createCommandRegistry()` is the only runtime construction entry. Import `CommandRegistry` with
`import type` when an annotation is needed; the implementation class is not a public constructor or
subclassing surface.

The registry is the only command catalog. Agent, HTTP, Workbench, and message adapters filter or
project `commands.list()`; they do not maintain parallel command registries.

Lookup by a runtime string cannot infer a particular output type, so registry and argv dispatch
return `unknown`. Call the original `Command` object when application code needs statically inferred
output; validate or narrow dynamic dispatch output in a carrier.

The owner that registers a command owns the disposer. In a Pluxel plugin, bind it to `ctx.effects`.
Disposal removes future lookup and discovery; it does not cancel an invocation that already obtained
the command. Abort in-flight work through its call-scoped `signal` when the host requires that policy.

## Project Agent/MCP tool information

```ts
import { toToolDescriptors } from '@pluxel/commands/tool'

const tools = toToolDescriptors(commands.list())
```

Each projected descriptor contains:

```ts
{
	name,
	title,
	description,
	inputSchema,
	outputSchema, // present only when declared
	annotations: {
		readOnlyHint,
		destructiveHint,
		idempotentHint,
		openWorldHint,
	},
	execution: { taskSupport: 'forbidden' },
}
```

The projection is pure. Frozen descriptors produced by commands are cached by identity; mutable
caller-owned descriptors are cloned and projected without caching. A provider adapter may rename a
tool or rewrite its JSON Schema dialect, but it must retain a reverse name mapping when dispatching
back to the registry.

The core invocation model is a single awaited operation, so task-augmented execution is reported as
`forbidden`. A future task carrier can advertise different execution semantics only when it really
implements task ownership, polling, cancellation, and retention.

Permissions, user confirmation, rate limits, credentials, audit, icons, provider `_meta`, and tool
selection remain carrier/host concerns. Filter descriptors before sending them to a model.

## Add argv or message syntax

```ts
import { createArgvRouter } from '@pluxel/commands/argv'

const argv = createArgvRouter()
argv.bind(pluginStatus, {
	routes: ['plugin status', 'status'],
	positionals: ['name'],
})

const resolution = argv.resolve('plugin status CachePlugin')
// { command, route: 'plugin status', candidate: { name: 'CachePlugin' }, rawArgs: 'CachePlugin' }

await argv.dispatchOrThrow('plugin status CachePlugin', context)

// A real CLI already has token boundaries. Pass them through without joining them back into text.
await argv.dispatchOrThrow(process.argv.slice(2), context)
```

`createArgvRouter()` is likewise the only runtime construction entry. `ArgvRouter` remains available
as a type, not as a second `new ArgvRouter()` construction style.

The first route is canonical; the rest are aliases. Binding compiles routes into a longest-prefix
trie. Dispatch tokenizes once, constructs an untrusted candidate object, then enters the same command
validation pipeline.

```text
Command input schema + explicit ArgvBinding
  -> compiled route, positionals, scalar options, choices, and defaults
  -> tokenize and longest-route match
  -> coerce argv values into an untrusted candidate object
  -> Command.executeOrThrow(candidate, context)
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

An `ArgvBinding` has one direct role for each field:

- `routes`: complete command routes; the first is canonical and the rest are aliases;
- `positionals`: schema fields consumed in their declared order;
- `options`: overrides for generated options, not an allowlist;
- `tail`: one text or JSON field that owns the remaining source.

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
different spellings. Positionals are explicit. Complex schemas must opt into JSON decoding:

```ts
argv.bind(patchConfig, {
	routes: ['plugin config patch'],
	positionals: ['name'],
	options: {
		patch: { format: 'json' },
	},
})

await argv.dispatchOrThrow(`plugin config patch CachePlugin --patch '{"enabled":true}'`, context)
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

`argv.help(nameOrRoute)` returns frozen data for a host-owned help renderer. Parameter descriptors
include scalar type, required state, aliases, description, closed string `choices`, and the schema's
strict JSON `defaultValue` when present. Generated usage uses typed placeholders such as `<integer>`
and `<json>` without exposing the full schema.

Unknown options and unmatched routes include up to three deterministic `suggestions`. Invalid
string-enum values report `allowedValues` and a close value when one exists. Suggestions are
computed only after a failure; successful dispatch does no fuzzy matching.

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

await argv.dispatchOrThrow('ban xewx -t 30 -- flooding and repeated abuse')
// The command receives:
// { member: 'xewx', durationMinutes: 30, permanent: false, silent: false,
//   reason: 'flooding and repeated abuse' }
```

This form keeps meanings visible, permits option reordering, and gives each invalid option a precise
error. ParseBox would add grammar code here without improving the public syntax.

## Decode a shared DSL with ParseBox

When a DSL is part of the command's domain contract, keep it as one public string and decode it with
the existing `Type.Transform()` boundary. Agent tools, argv, HTTP, and direct callers then submit the
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

// Agent tool, HTTP, registry, or direct call: the public value is the DSL string.
await searchPlayers.executeOrThrow({ query: 'warnings >= 3', limit: 25 })

// A named CLI option carries one quoted shell token into the same Transform.
await cli.dispatchOrThrow('players search --query "warnings >= 3" --limit 25')

// A message-oriented host may instead make the DSL its unquoted text tail.
const messages = createArgvRouter()
messages.bind(searchPlayers, {
	routes: ['players search'],
	options: { limit: { aliases: ['l'] } },
	tail: tail.text('query', '<filter-expression>'),
})
await messages.dispatchOrThrow('players search --limit 25 -- warnings >= 3')

// All executions receive:
// query = { source: 'warnings >= 3',
//           expression: { field: 'warnings', operator: '>=', threshold: 3 } }
```

The JSON descriptor and Agent tool schema expose `query` as the annotated string, including its
grammar description and examples. Transform functions stay private. The normal command pipeline
validates the wire string, decodes it exactly once, and turns a parser throw or trailing input into
`INPUT_VALIDATION` before `execute()` runs. A Decode callback may deliberately throw a structured
`CommandError('INPUT_VALIDATION', ...)`; commands preserves its issue path, stable code, and safe
message for Agent self-correction.

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
- `@pluxel/commands/tool`: cached provider-neutral tool projection;
- `@pluxel/commands/argv`: route trie, argv parsing, help data, and text/JSON tails.

Repository integration constraints are in [`docs/COMMANDS.md`](../../docs/COMMANDS.md); package
implementation invariants and CLI ecosystem decisions are in [`docs/DESIGN.md`](docs/DESIGN.md).

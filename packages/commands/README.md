# @pluxel/commands

Define a validated JSON command once and expose it through a registry, argv/message router or host-owned Agent/HTTP carrier. The package is independent of Plugin lifecycle and transport SDKs.

```sh
pnpm add @pluxel/commands
```

| Entry              | Responsibility                                             |
| ------------------ | ---------------------------------------------------------- |
| `@pluxel/commands` | Definition, execution, errors, validation and registry     |
| `/typebox`         | JSON TypeBox builder, `obj()` and `openObj()`              |
| `/argv`            | Routes, generated options, positionals and text/JSON tails |

## Define and execute

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

`command.execute(input, context?)` is the only execution boundary. The returned command captures the typed handler privately; all calls validate input and declared output. Omit `output` when success has no business payload: execution must return `undefined`, otherwise it fails with `OUTPUT_VALIDATION`.

| Definition field             | Meaning                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| `name`                       | Stable case-sensitive registry identity                             |
| `title`, `description`       | Display label and semantic selection text; no carrier syntax        |
| `behavior`                   | Worst-case side effects, not permission                             |
| `input`, `output`            | JSON object-root wire contracts; output is optional                 |
| `examples`                   | Whole-call wire input/output, checked and frozen at definition time |
| `validate`, `validateOutput` | Constraints over decoded domain values                              |
| `execute`                    | Typed business implementation                                       |

Query behavior is `{ kind: 'query', world: 'closed' | 'open' }`. Mutation also requires `destructive` and `idempotent` booleans. Open-world means interaction beyond a bounded application domain. Use separate commands when materially different dangers would otherwise hide behind an argument flag.

Base context may be omitted; a custom context with required fields must be supplied. Context capability functions must be receiver-independent because hosts may project the record. `signal` supports cooperative cancellation; `deadlineMs` is an absolute Unix timestamp checked between stages and before return, not forced interruption of a handler.

## Schema, codecs and errors

```text
wire input → strict JSON clone + defaults + validation → Transform Decode
           → custom validate → handler → Transform Encode
           → strict JSON clone + output validation → [Decode + validateOutput, if supplied] → wire output
```

- Object schemas are closed, including nested objects; use `openObj()` for intentional extra properties.
- Wire values remain strict JSON even under Any/Unknown: functions, BigInt, class instances, non-finite numbers, sparse arrays, cycles, accessors and symbol properties fail. Domain values inside codecs/handlers may use richer types.
- Input defaults are schema-checked at definition time. Output and output examples never receive defaults.
- References must be self-contained: use `Type.Module().Import()` to embed definitions. Standalone `Type.Ref(schema)` fails with `COMMAND_CONFIG` / `unresolved_reference`.
- `Type.Transform()` decodes input and encodes output; its underlying JSON schema is public, codec functions are private. Examples never execute codecs.
- Descriptions explain meaning; field examples belong in schema annotations, complete calls in `examples`, argv strings beside their bindings. Provider-specific tool projection belongs to the carrier.

```ts
const BigInteger = Type.Transform(Type.String({ pattern: '^-?\\d+$' }))
	.Decode((value) => BigInt(value))
	.Encode((value) => String(value))
```

Use `validation.constraint(path, message, { code? })` for cross-field constraints. Input Decode errors become `INPUT_VALIDATION`; Encode, invalid handler results and Decode for a custom output validator become `OUTPUT_VALIDATION`. A structured `INPUT_VALIDATION` thrown by a Decode callback preserves its safe message and issues.

Carriers branch on `CommandError.code` and `kind`, expose `publicMessage`, and retain `message`/`cause` for diagnostics. Expected errors include invalid input, denial, cancellation and timeout; configuration, invalid output, dependency and internal failures are faults. Never forward arbitrary abort reasons or diagnostic causes to untrusted callers.

## Registry and publication lifetime

```ts
import { createCommandRegistry } from '@pluxel/commands'

const commands = createCommandRegistry()
const registration = commands.register(jobStatus)
await commands.execute('job.status.get', { jobId: 'cache-refresh' }, context)
commands.snapshot() // { revision, descriptors }; stable until mutation
registration.dispose()
```

`createCommandRegistry()` is the construction entry; `CommandRegistry` is a type. The registry owns name lookup, revision, frozen descriptors and subscriptions. `list()` returns the snapshot descriptors. `subscribe()` observes later mutations without an initial emission; synchronous revision-ordered notifications isolate listener failures and queue reentrant changes. Disposers are idempotent.

The typed registration is a live `InstalledCommand`: every call resolves its name again. Replacement follows the new implementation only if name and canonically serialized input/output schemas match; withdrawal or incompatible replacement gives `COMMAND_NOT_FOUND`. Changes to presentation, behavior or examples do not invalidate the handle. Disposal does not cancel admitted calls.

A carrier requiring one implementation accepts `DirectCommand`, not an installed handle. Direct definitions exclude `dispose`; cleanup belongs to publication. This type distinction does not replace runtime validation at untyped boundaries. Dynamic string dispatch returns `unknown`; call the original command for statically inferred output.

Pluxel integration uses `@pluxel/services/commands`: root catalog `register()` and generation-pinned `createMount()` publication are separate choices. Owner admission/cancellation belongs to the service, not this standalone registry; see [runtime commands](../../docs/runtime/commands.md).

## Argv and message syntax

```ts
import { createArgvRouter, tail } from '@pluxel/commands/argv'

const argv = createArgvRouter()
argv.bind(jobStatus, { routes: ['job status', 'status'], positionals: ['jobId'] })
const match = argv.resolve(process.argv.slice(2))
if (match) await match.command.execute(match.candidate, context)
```

Raw message strings are tokenized once; pass shell token arrays unchanged, never `join(' ')`. A router accepts one active binding per command name; dispose before rebinding. Routes use lowercase grammar and longest-prefix matching, case-insensitive by default. With `caseInsensitive: false`, uppercase routes do not match. Raw text is bounded by `maxTextLength` (default 16 KiB, positive safe integer).

| Binding                        | Rule                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `routes`                       | First route is canonical, remaining routes are aliases                                                          |
| `positionals`                  | Existing fields consuming one token each; option parsing continues                                              |
| `options`                      | Rename/alias remaining scalar fields or select JSON decoding; omitted scalar fields still get generated options |
| `tail.text(key, placeholder?)` | Remaining source into a string wire field, including string-backed Transform                                    |
| `tail.json(key, placeholder?)` | Remaining source parsed as one JSON value                                                                       |

A field cannot be both positional/tail and option. Complex fields require explicit `format: 'json'` in custom options; unsupported mappings fail during bind. String, number, integer, boolean, string-enum and scalar-array fields can become options. Names use kebab-case; option matching ignores case and equates `_` with `-`. Short aliases are explicit.

| Syntax                                                 | Meaning                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `--name value`, `--name=value`, `-n value`, `-n=value` | Named value                                                  |
| `--flag`, `--flag=false`, `--no-flag`                  | Boolean; an exact `no-flag` field wins over negation         |
| `-abc`                                                 | Grouped aliases only if all are booleans                     |
| repeated scalar / array                                | Scalar duplicates fail; array values append                  |
| `--`                                                   | Stop option recognition, fill pending positionals, then tail |

Options may interleave with positionals until tail begins. Use `--` before hyphen-leading positionals. Once tail begins, option-looking text belongs to it. Raw text tails preserve the substring apart from outer whitespace; token-array tails join with single spaces because shell quoting is already gone.

`resolve()` returns an untrusted candidate and command, or `undefined` for unmatched routes; it does not execute. Heterogeneous output is `unknown`; `createArgvRouter<MyContext, MyOutput>()` restricts bindings when all commands share an output contract. `ArgvRouter` is a type, not a public constructor.

`list()` returns frozen help data: aliases, descriptions, types, requiredness, choices, defaults and typed usage placeholders. Unknown options suggest at most three deterministic matches; invalid enums report allowedValues and a close match. Suggestions run only on failure. Authorization, help rendering and provider name mapping belong to the carrier.

## A shared domain language

Ordinary IDs and flags need no parser. A true DSL stays one annotated wire string, decoded inside `Type.Transform()` so Agent, HTTP and argv use the same contract. Options carry a quoted token; `tail.text()` suits an unquoted primary remainder. ParseBox is optional and application-owned:

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
```

The retained `source` provides Encode without requiring a second formatter; an existing canonical printer is also valid. Reject trailing parser input. The router only delivers the string; the command pipeline decodes it exactly once.

Implementation invariants: [docs/DESIGN.md](./docs/DESIGN.md). Pluxel ownership: [engineering/COMMANDS.md](../../engineering/COMMANDS.md).

# Commands and Agent tools

Use `@pluxel/commands` when one capability must be callable through Agent tools, argv/messages,
HTTP, Workbench, or internal host code.

```ts
import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

export const status = defineCommand({
	name: 'plugin.status.get',
	description: 'Read one plugin status.',
	behavior: { kind: 'query', world: 'closed' },
	input: obj({ name: Type.String({ examples: ['CachePlugin'] }) }),
	output: obj({ running: Type.Boolean() }),
	examples: [
		{ title: 'Running plugin', input: { name: 'CachePlugin' }, output: { running: true } },
	],
	execute: ({ name }) => readPluginStatus(name),
})
```

Use this mental model:

- `name` is stable machine identity;
- `title` is optional display text;
- `description` helps humans and models select the command;
- `behavior` describes worst-case side effects;
- `input` and optional `output` are the structured external contract;
- `examples` contains optional structured calls, not CLI/message strings;
- `execute` is the typed implementation.

The exported `Type` helper builds JSON-compatible schemas. Direct Date, BigInt, function, and binary
schemas are rejected because Agent and JSON boundaries cannot represent those values. Use a
JSON-backed `Type.Transform()` when the handler should receive a domain value: the command decodes
validated input before `validate`/`execute` and encodes handler output before returning it. Schemas,
examples, command results, and carriers always use the underlying JSON representation.

Wire values must be real JSON even under `Type.Any()`: functions, BigInt, class instances, NaN,
cycles, and values that JSON would silently discard are rejected. Input defaults are applied before
Decode. Output defaults are annotations only; commands must explicitly return every output value
they intend to publish.

Omit `output` when a command only reports success or failure. Its result type is then
`CommandResult<void>`, `executeOrThrow()` resolves `undefined`, and Agent projections omit
`outputSchema`. Declare output whenever callers need a business fact such as `changed` or `status`;
the package never adds a redundant `{ ok: true }` payload.

Keep `description` focused on what the command does and when to use it. Put representative field
values in JSON Schema `examples`, and complete input/output cases in command `examples`. Keep argv
or chat syntax with its adapter binding because routes and quoting vary by carrier. Provider bridges
can read `CommandDescriptor.examples`; the core does not concatenate them into descriptions.

Queries declare whether they interact with a `closed` application domain or the `open` external
world. Mutations additionally declare `destructive` and `idempotent`. Behavior is not permission;
the host still authenticates the caller, authorizes the command, and confirms sensitive calls.

Register commands once in `CommandRegistry`. Agent adapters convert `registry.list()` with
`toToolDescriptors()` and dispatch calls back through `registry.execute()`. Text adapters bind the
same command with `@pluxel/commands/argv`. Do not create a second command registry for each carrier.
Use `createCommandRegistry()` and `createArgvRouter()` to construct them; their class names are
type-only exports, so external code has one runtime construction style.

Call `execute()` at untrusted boundaries and branch on its result. Use `executeOrThrow()` only when a
carrier already translates `CommandError`; it still performs all validation.

The base `CommandContext` is optional. A host that extends it with required request-scoped fields
must provide that context through direct, registry, and argv execution.

For argv, use explicit positionals and generated scalar options. Help displays one canonical
kebab-case option name, while input matching ignores case and treats `_` like `-`; use aliases for
short or genuinely different names. `argv.help()` also exposes scalar types, string choices, schema
defaults, and required state without publishing the full schema. Unknown options, routes, and enum
values include bounded correction hints. Complex fields must explicitly use JSON decoding.

Prefer conventional CLI syntax for conventional data: one or two obvious required values can be
positionals, optional or reorderable values should be options, and arbitrary trailing prose should
use `tail.text()` after `--`. For example, prefer `ban xewx -t 30 -- flooding` over implementing
`ban @xewx for 30 minutes because flooding` as a ParseBox grammar.

When a DSL such as `warnings >= 3 and playtime < 10` is part of the command contract, expose one
annotated string field and decode it with a ParseBox-backed `Type.Transform()`. Agent tools, argv,
HTTP, registry, and direct callers then submit the same DSL; `execute()` receives the ParseBox
mapping product. For argv, expose it as a quoted string option when a named, reorderable value is
clearer, or bind it with `tail.text()` when it is the primary remainder and message users should not
need quoting. Parser failures use the normal `INPUT_VALIDATION` codec boundary. This avoids
publishing a second AST language just for Agents.

For a parser-only DSL, Decode can retain `{ source, expression }` and Encode can return `source`, so
no formatter is required merely to satisfy the input Transform. A Decode callback may throw a
structured `INPUT_VALIDATION` `CommandError` to give Agents a safe issue path, stable code, and
repairable message; unrelated codec faults stay generic.

In `ArgvBinding`, `positionals` reserves ordered schema fields, `options` customizes automatically
generated options, and `tail` owns the remaining text or JSON source. `options` is not an
allowlist: unlisted scalar fields still receive canonical kebab-case options. Long options accept
`--name value` and `--name=value`; explicit one-character aliases accept `-n value`; boolean options
also accept `--flag=false`, `--no-flag`, and all-boolean short groups. Duplicate scalars fail and
repeated arrays accumulate.

`tail.text(key)` suggests only string wire fields from the Command input, including string-backed
Transforms. `tail.json(key)` suggests every input field and parses the remainder as one JSON value.
Their optional second argument customizes the help placeholder. Untyped text-tail bindings to a
non-string schema fail during `bind()`.

Options may appear before or after positionals until a tail starts. `--` stops option recognition
but does not skip pending positionals; those are consumed first and only the remainder enters tail.
Once tail consumption starts, option-looking text belongs to that tail field.

ParseBox may technically parse ordinary flags, but doing so discards generated help, aliases,
reordering, defaults, and precise option failures. Keep outer CLI syntax in the argv router and use
ParseBox only inside a string Transform whose domain language genuinely has a grammar. The
Transform works identically whether the string came from `--query "..."` or `tail.text()`; `--` is
only an argv boundary and does not activate parsing.

Argv is a carrier projection, not a second execution implementation: it matches a route, constructs
a candidate object, and calls the same validated `Command` boundary used by registry and Agent tools.
Pass raw strings for chat/message commands and pass `process.argv.slice(2)` directly for a CLI; do
not join already-tokenized argv because that loses argument boundaries. Schema defaults are checked
when the command is defined and then applied only to command input.

See the complete recipes and lifecycle rules in the
[`@pluxel/commands` README](../packages/commands/README.md).

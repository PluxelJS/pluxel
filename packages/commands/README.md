# @pluxel/commands

Define a validated operation, call it directly, or publish it by name. Commands are independent of Plugin lifecycle and protocol transports.

```ts
import { createCommandRegistry, defineCommand, Result } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'

const echo = defineCommand({
	name: 'text.echo',
	description: 'Return the input text.',
	input: obj({ text: Type.String() }),
	execute({ text }) {
		return Result.ok(text)
	},
})

const direct = await echo.execute({ text: 'hello' })
if (direct.isErr()) console.error(direct.error.code, direct.error.message)
else console.log(direct.value)

const commands = createCommandRegistry()
using registration = commands.register(echo)
await registration.execute({ text: 'hello' }) // fixed registration
await commands.execute('text.echo', { text: 'hello' }) // dynamic name lookup
```

`defineCommand` accepts exactly `name`, `description`, `input`, and `execute`. The handler receives decoded input and a trusted `CommandContext`. It returns `Result.ok(value)` or `Result.err(failure)`, synchronously or asynchronously. The public `execute` accepts wire input and returns `Promise<Result<T, CommandFailure>>`. A known command checks its wire input, output value, and required context at compile time; dynamic names and JavaScript callers are checked at runtime.

The input must be a TypeBox object schema. Input is cloned as strict JSON, defaults are filled, validation runs, and Transform codecs decode once before the handler. Nested object schemas are closed by default. Use `openObj()` for extra fields. Optional fields must be declared with `Type.Optional()` for typed callers to omit them. `input` schema examples describe complete wire inputs; field examples belong on their fields.

`CommandFailure` distinguishes `INPUT_VALIDATION` with issues, `REJECTED` with a stable reason, and boundary failures such as `ABORTED`, `TIMEOUT`, `DEPENDENCY`, and `INTERNAL`. The handler should return recoverable business failures explicitly. Thrown errors and malformed Results become `INTERNAL` with a local diagnostic cause. The kernel does not validate or encode successful business values; protocol carriers check what they can transmit.

A direct call accepts optional `signal` and absolute `deadlineMs` in context. Cancellation reaches the handler through a composed signal. Execution waits for the handler to finish; a valid Result remains authoritative even if cancellation arrives while it runs. A rejection matching the active cancellation reason becomes `ABORTED` or `TIMEOUT`; unrelated rejections remain `INTERNAL`.

A registration has immutable `name` and `descriptor`, typed `execute`, idempotent `dispose`, and `Symbol.dispose`. Registration captures the source command's execute function; changing that property later does not change the published operation. After disposal it returns `COMMAND_NOT_FOUND`; a later registration with the same name never revives the old handle. `commands.execute(name, input)` follows the current registration and returns an unknown success type. Registry snapshots cache their identity until mutation; subscriptions receive ordered revisions, and observer failures are isolated.

Argv routes parse syntax and construct an untrusted candidate for the same execution boundary:

```ts
import { createArgvRouter, tail } from '@pluxel/commands/argv'

const router = createArgvRouter()
using binding = router.bind(echo, { routes: ['text echo'], tail: tail.text('text') })
const resolved = router.resolve('text echo hello')
if (resolved) {
	const result = await resolved.command.execute(resolved.candidate)
	if (result.isErr()) console.error(result.error.message)
}
```

`resolve()` returns `undefined` for an unmatched route. Malformed argv raises `CommandError` with `ARGUMENT_SYNTAX`; the CLI or chat carrier decides how to present it. The router supports generated options, positionals, and text/JSON tails. The [runtime guide](../../docs/runtime/commands.md) covers Plugin publication.

## @pluxel/commands@2.0.0

### Make Command execution return Better Result

Define Commands with name, description, input, and a Result-returning execute handler. Direct, registry, and argv calls now return `Result<T, CommandFailure>`. A fixed registration handle stops when disposed, and dynamic name lookup follows the current registration. Remove the obsolete `InstalledCommand` alias. Cancellation reaches the handler and cannot overwrite a completed Result. Remove output schemas and behavior metadata from Command definitions.
The execution boundary rejects a returned Result whose status conflicts with its branch methods.
Absolute deadlines beyond the platform timer range remain scheduled until their actual time instead of expiring immediately.
Framework deadline cancellation remains `TIMEOUT` when its signal passes through owner or carrier signal composition into a nested Command.
Use `toCli()` to compile an argv projection before publishing it with `router.bind()`; the router now accepts that projection instead of a Command and separate syntax options.

### Add a native Cap'n Web adapter for Commands

`@pluxel/commands/adapters` exposes `toCapnweb({ method: command })`. It creates a native `RpcTarget` class whose methods execute selected Commands with a trusted constructor context and return JSON data results.
The adapter rejects method and data keys that Cap'n Web cannot preserve and checks its encoder before reporting a successful result.

### Keep carrier handling inside publication ownership

Command mounts accept `{ install, handle? }` instead of an installer callback. The optional
handler receives the captured Command, untrusted input, and carrier context; authorization,
context projection, execution, and response presentation settle within the provider and
publisher invocations. A custom handler can project its own output type and construct a
command-specific context. Direct bindings still execute the selected Command unchanged.

Mounted endpoints carry an explicit marker and cannot be re-mounted as direct definitions.
The new `snapshotCommand()` captures and validates the descriptor and execute function without
creating a temporary registry, preserving the receiver and existing publication withdrawal.

### Add a native MCP Tool projection for Commands

`@pluxel/commands/adapters` exposes `toMcp(command)`, producing a native MCP Tool descriptor and a per-call handler. Applications own tool publication, authentication, transport and lifecycle. The adapter maps Command Results to MCP text results without exposing local causes.

### Isolate Command protocol entry points

Replace `@pluxel/commands/adapters` with `@pluxel/commands/mcp` and `@pluxel/commands/capnweb`. The Cap’n Web peer is optional; kernel and MCP consumers no longer need to install or load it. MCP SDK remains an optional type dependency.

### Refresh supported tooling and generated projects

Update runtime, rendering, validation and tooling dependencies together across the published packages and generated projects.
New projects use Elysia 2 beta.19 and TypeScript 7, with TypeBox 1.3.23 pinned for Elysia eager schema compilation.
Update fixture dependencies while retaining the tested VFS release until its newer release restores trusted-publisher evidence.

Read extracted HTML CSS through Takumi’s current `css` result field, avoiding its deprecated alias and per-process warning.

## @pluxel/commands@1.0.0

### Initial open-source release

Publish the supported Pluxel packages together at 1.0.0. Current package contracts and development workflows are documented in the repository.

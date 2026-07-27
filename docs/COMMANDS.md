# Commands

`@pluxel/commands` is the transport-neutral command kernel for capabilities that may be exposed to
agents, CLIs, chat messages, HTTP, or Workbench-backed host integrations. Its flat descriptor uses
`name`, optional `title`, `description`, structured `behavior`, `inputSchema`, optional
`outputSchema`, and optional structured `examples`. Commands with no business return value use
`CommandResult<void>` rather than a duplicated success payload.

The package owns schema compilation, normalized invocation, structured errors, registry lookup,
provider-neutral tool descriptors, and argv routing. It does not own a global registry or install
commands into every runtime.

Runtime construction is factory-only: `createCommandRegistry()` and `createArgvRouter()` are the
public values, while `CommandRegistry` and `ArgvRouter` are type-only exports. Argv bindings reserve
ordered `positionals`, customize generated `options`, and optionally assign the remainder to a
text/JSON `tail`; they never define a second input schema. Conventional scalar inputs and trailing
prose stay in positionals, generated options, and `tail.text()`. A domain DSL shared by Agent, argv,
HTTP, and direct callers remains an annotated string decoded by an application-owned
ParseBox-backed `Type.Transform()`, so `execute()` receives the parser product without publishing an
AST wire contract. An argv host may carry that string as a quoted option or as the unquoted text
tail; both enter the same Transform. Parser-only DSLs may retain their source for the Encode
direction, and deliberate structured input-validation errors survive TypeBox's Transform wrapper.

All carrier values remain strict JSON even under permissive schemas. Input defaults apply before
Transform Decode; output is validated exactly as the handler encoded it. Catalog ordering is
locale-independent, and text parser failures stay on the structured argument-syntax boundary.

Runtime and host integrations must preserve these boundaries:

- lifecycle behavior remains implemented by the existing core/runtime use case;
- a command handler delegates to that use case rather than reproducing start/stop logic;
- the installing host owns exposure, principal mapping, permission, confirmation, audit, and
  registration lifetime;
- plugins bind registrations to their owner effects;
- disabled carriers do not allocate servers, model clients, or watchers;
- Agent adapters filter descriptors before publishing a tool catalog and map behavior to standard
  read-only, destructive, idempotent, and open-world annotations.

Implementation entry points:

- `packages/commands/src/define.ts`: validated execution boundary;
- `packages/commands/src/registry.ts`: lookup and lifecycle-neutral registration;
- `packages/commands/src/tool/project.ts`: Agent-neutral tool projection;
- `packages/commands/src/argv/router.ts`: trie routing and strict argv projection;
- `packages/commands/src/argv/tail.ts`: text and JSON remainder binding.

Public usage is documented in [`user-docs/commands.md`](../user-docs/commands.md) and the package
[`README`](../packages/commands/README.md).

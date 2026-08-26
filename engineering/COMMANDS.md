# Commands

`@pluxel/commands` is the transport-neutral command kernel for capabilities exposed through Agent,
argv/message, HTTP, or Workbench-backed host integrations. This document is authoritative for its
repository integration and lifecycle boundaries.

Documentation ownership is deliberately split:

- [`docs/runtime/commands.md`](../docs/runtime/commands.md): standard author and host usage;
- [`packages/commands/README.md`](../packages/commands/README.md): complete package API and recipes;
- [`packages/commands/docs/DESIGN.md`](../packages/commands/docs/DESIGN.md): package implementation,
  performance, parser, and projection decisions.

Runtime and host integrations must preserve these boundaries:

- lifecycle behavior remains implemented by the existing core/runtime use case;
- a command handler delegates to that use case rather than reproducing start/stop logic;
- the installing host owns exposure, principal mapping, permission, confirmation, audit, and
  registration lifetime;
- runtime registrations retain their plugin Context owner;
- disabled carriers do not allocate servers, model clients, or watchers;
- Agent adapters filter descriptors before publishing a tool catalog and map behavior to standard
  read-only, destructive, idempotent, and open-world annotations.

Runtime hosts use `ctx.root.agentTools` when the filtered catalog must be managed persistently. It keeps
user-defined Toolsets and Agent assignments outside command definitions: a Toolset is an explicit set of
stable command names, and one Agent receives the union of its assigned Toolsets. An Agent with no assignment
receives no commands. Missing command names remain in policy and become available again when a plugin
publishes the same stable name.

`await ctx.root.agentTools.catalog(agentId)` returns a live constrained catalog. Its `list()` only exposes
currently registered commands assigned to that Agent; its single throwing `execute()` checks the current
assignment again before dispatching through the root command catalog. Carriers must use this bound
catalog for both publication and execution. Calling `ctx.root.commands.execute()` directly would bypass the
Agent assignment and is only appropriate for a separately authorized host control path.

The bound catalog publishes `{ catalogRevision, policyRevision }` snapshots and subscriptions. Command
registration, withdrawal, replacement, or Toolset edits therefore invalidate carrier projections without
creating a second registry. A policy edit does not cancel calls already admitted before the edit; it prevents
subsequent calls, matching command publication withdrawal semantics.

`@pluxel/runtime` installs one root registry behind `ctx.commands`. Its list, snapshot, subscription, and
execution methods delegate to that registry, so runtime does not maintain another revision or listener set.
`register()` returns the registry's typed installed command plus disposer and binds disposal to the calling
Plugin Context's effects. Runtime wraps execution in the owner's internal invocation gate; Core closes and
drains that gate once per generation before effects drain. A manually disposed registration withdraws
publication and does not cancel work that already entered execution or close sibling admission.

The runtime's built-in plugin management commands use the same catalog. Unscoped host-control carriers
consume `ctx.root.commands.list()` and dispatch through `execute()` rather than copying descriptors or
handlers; Agent carriers with a persisted assignment consume their bound `agentTools.catalog()` view.

An argv/message carrier explicitly binds its allowed commands to `createArgvRouter()`. The router owns only
route grammar and candidate construction: after `resolve()`, the carrier performs authorization, constructs
the invocation Context, and calls the returned command's throwing `execute()`. It does not own a mirrored
command catalog or carrier policy. The workspace `@pluxel/cli` executable remains a build/development tool
and is not implicitly connected to a running runtime.

The runtime catalog accepts commands requiring the common `CommandContext`. A carrier that constructs
additional invocation facts owns a registry/router parameterized by its extended context. Common commands
can bind to that carrier; commands requiring the extended context cannot enter the runtime catalog.
Carrier bindings own route syntax and result rendering, while the same `Command` remains the reusable
business definition.

Implementation entry points:

- `packages/commands/src/schema.ts`: single schema projection, validation, and codec compiler;
- `packages/commands/src/compile.ts`: final command plan, descriptor, and example compilation;
- `packages/commands/src/define.ts`: validated call-time execution boundary;
- `packages/commands/src/registry.ts`: lifecycle-neutral registration, discovery, and dynamic dispatch;
- `packages/commands/src/argv/compile.ts`: schema-derived argv binding and help compilation;
- `packages/commands/src/argv/parse.ts`: option coercion and untrusted candidate construction;
- `packages/commands/src/argv/router.ts`: trie registration, routing, and resolution;
- `packages/commands/src/argv/tail.ts`: text and JSON remainder binding.
- `packages/runtime/src/services/commands/AgentToolsService.ts`: persisted Toolsets, Agent assignments,
  constrained catalog projection, and call-time enforcement.

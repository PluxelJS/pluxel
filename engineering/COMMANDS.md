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

Runtime does not install an Agent, Toolset, provider adapter, policy store, or Agent-specific Management API.
Hosts that need managed Agent allowlists install the ordinary official `@pluxel/agent-tools` Plugin. Its
Toolsets and Agent assignments are one standard Plugin config, so ConfigService remains the only persistence,
validation, and update authority. Missing stable command names remain in config and become available when a
Plugin publishes the same name.

`AgentToolsPlugin.catalog(agentId)` returns a live constrained catalog. Its `list()` only exposes
currently registered commands assigned to that Agent; its single throwing `execute()` checks the current
assignment again before dispatching through the root command catalog. Carriers must use this bound
catalog for both publication and execution. Calling `ctx.commands.execute()` directly would bypass the
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

Carrier providers that publish a command into their own router or SDK callback surface use
`ctx.commands.createMount<CarrierContext>()`. A mount is not a second registry: it has no name lookup,
snapshot, subscription, dynamic execution, or caller-supplied owner. Its caller-bound `bind()` accepts a
`DirectCommand`, pins the exact command implementation to the provider and publication-owner generations,
and adopts the provider's synchronous route/SDK registration into the publication owner's effects. The
returned handle is a plain disposer, not an executable installed command.

`DirectCommand` is the commands-package type for an exact implementation. Ordinary `defineCommand()`
results and hand-authored commands satisfy it, while the compatible-replacement handle returned by a
registry does not—even when widened to `InstalledCommand`. This is a type-level misuse guard; JavaScript
carrier entry points and Runtime still validate received objects. Root catalog publication and carrier
publication remain two independent, explicit decisions.

The runtime's built-in plugin management commands use the same catalog. Unscoped host-control carriers
consume `ctx.root.commands.list()` and dispatch through `execute()` rather than copying descriptors or
handlers; Agent adapter Plugins consume a constructor-injected `AgentToolsPlugin` bound catalog.

An argv/message carrier explicitly binds its allowed commands to `createArgvRouter()`. The router owns only
route grammar and candidate construction: after `resolve()`, the carrier performs authorization, constructs
the invocation Context, and calls the mounted command's throwing `execute()`. It may maintain one private
catalog only when the carrier has a real discovery use case, but the route must retain the mounted direct
command rather than a registry-installed handle. The workspace `@pluxel/cli` executable remains a
build/development tool and is not implicitly connected to a running runtime.

The root runtime catalog accepts commands requiring the common `CommandContext`. A carrier that constructs
additional invocation facts parameterizes its mount/router with that extended context. Common direct
commands can mount into the carrier; commands requiring the extended context cannot enter the root catalog.
Carrier declarations own route syntax, admission and result rendering, while the underlying command keeps
the single schema/validation/codec/execution pipeline. Presentation and error rendering must settle inside
the mounted execution so both provider and publication-owner admission remain held.

Implementation entry points:

- `packages/commands/src/schema.ts`: single schema projection, validation, and codec compiler;
- `packages/commands/src/compile.ts`: final command plan, descriptor, and example compilation;
- `packages/commands/src/define.ts`: validated call-time execution boundary;
- `packages/commands/src/registry.ts`: lifecycle-neutral registration, discovery, and dynamic dispatch;
- `packages/commands/src/argv/compile.ts`: schema-derived argv binding and help compilation;
- `packages/commands/src/argv/parse.ts`: option coercion and untrusted candidate construction;
- `packages/commands/src/argv/router.ts`: trie registration, routing, and resolution;
- `packages/commands/src/argv/tail.ts`: text and JSON remainder binding.
- `packages/runtime/src/services/CommandsService.ts`: root publication and owner-bound carrier mounts;
- `plugins/agent-tools/src/index.ts`: optional Toolset/Agent config projection and call-time enforcement.

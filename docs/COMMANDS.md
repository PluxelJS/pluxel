# Commands

`@pluxel/commands` is the transport-neutral command kernel for capabilities exposed through Agent,
argv/message, HTTP, or Workbench-backed host integrations. This document is authoritative for its
repository integration and lifecycle boundaries.

Documentation ownership is deliberately split:

- [`user-docs/commands.md`](../user-docs/commands.md): standard author and host usage;
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

`@pluxel/runtime` installs one root catalog behind `ctx.commands`. `register()` binds the returned
registry registration to the calling plugin Context's effects, so stop, replacement, failed startup,
and shutdown remove future discovery and lookup automatically. Runtime registration also wraps execution
in the owner's internal invocation gate. Leaving the running generation closes admission, aborts the
combined call/owner signal, and waits for admitted invocations before the plugin `stop()` hook. A manually
disposed registration only withdraws publication and does not cancel work that already started.

The runtime's built-in plugin management commands use the same catalog; carriers must consume
`ctx.root.commands.list()` and dispatch through `execute()` rather than copying descriptors or handlers.

`createCommandArgv(catalog)` is the conservative default argv projection for an installed CLI carrier.
Its first token is the exact command name, scalar input fields become generated named options, and complex
fields use the existing field-level JSON format. It resolves one current command handle, lazily caches one
single-command router by handle identity, then dispatches back through `catalog.executeOrThrow()`. It does
not build a mirrored registry or catalog-wide route trie. The workspace `@pluxel/cli` executable is a
build/development tool and is not implicitly connected to a running runtime.

The runtime catalog accepts commands requiring the common `CommandContext`. A carrier that constructs
additional invocation facts owns a registry/router parameterized by its extended context. Common commands
can bind to that carrier; commands requiring the extended context cannot enter the runtime catalog.
Carrier bindings own route syntax and result rendering, while the same `Command` remains the reusable
business definition.

Implementation entry points:

- `packages/commands/src/schema.ts`: single schema projection, validation, and codec compiler;
- `packages/commands/src/compile.ts`: final command plan, descriptor, and example compilation;
- `packages/commands/src/define.ts`: validated call-time execution boundary;
- `packages/commands/src/registry.ts`: lookup and lifecycle-neutral registration;
- `packages/commands/src/tool/project.ts`: Agent-neutral tool projection;
- `packages/commands/src/argv/compile.ts`: schema-derived argv binding and help compilation;
- `packages/commands/src/argv/parse.ts`: option coercion and untrusted candidate construction;
- `packages/commands/src/argv/router.ts`: trie registration, routing, and dispatch;
- `packages/commands/src/argv/catalog.ts`: lazy default argv projection over a live catalog;
- `packages/commands/src/argv/tail.ts`: text and JSON remainder binding.

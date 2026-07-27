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
- plugins bind registrations to their owner effects;
- disabled carriers do not allocate servers, model clients, or watchers;
- Agent adapters filter descriptors before publishing a tool catalog and map behavior to standard
  read-only, destructive, idempotent, and open-world annotations.

Implementation entry points:

- `packages/commands/src/define.ts`: validated execution boundary;
- `packages/commands/src/registry.ts`: lookup and lifecycle-neutral registration;
- `packages/commands/src/tool/project.ts`: Agent-neutral tool projection;
- `packages/commands/src/argv/compile.ts`: schema-derived argv binding and help compilation;
- `packages/commands/src/argv/parse.ts`: option coercion and untrusted candidate construction;
- `packages/commands/src/argv/router.ts`: trie registration, routing, and dispatch;
- `packages/commands/src/argv/tail.ts`: text and JSON remainder binding.

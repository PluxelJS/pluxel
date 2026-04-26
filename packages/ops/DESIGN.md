# @pluxel/ops Design

`@pluxel/ops` is intentionally narrow: one authoring API, one descriptor, one execution boundary, one registry-backed runtime home.

The root entry exports ops primitives only. TypeBox authoring helpers are a dedicated subpath:

```ts
import { defineOp } from '@pluxel/ops'
import { Type, obj } from '@pluxel/ops/typebox'
```

## Core Model

1. Authoring config: `defineOp({ id, input, output, doc, exposure, policy, cli, tool, execute })`
2. Descriptor: frozen, serializable metadata compiled once.
3. Operation: `{ id, descriptor, run, runSafe }` plus hidden runtime metadata.

After definition, carriers read the descriptor. They do not reinterpret authoring config.

## Descriptor Contract

`OpDescriptor` is the public intermediate representation.

- `id`: stable operation identity.
- `doc`: human and tool guidance.
- `exposure`: non-carrier visibility such as `rpc` and `internal`.
- `policy`: execution semantics such as `mutating`, `idempotent`, `confirm`, and `audit`.
- `schemas`: JSON Schema projections for input and output.
- `params`: derived object-input summary for carriers.
- `transports`: carrier projections, currently CLI and tool.

Descriptors must not contain live parser modules, caches, owner metadata, or other runtime objects.

## Execution Boundary

Every invocation follows:

`candidate -> validated input -> execute -> validated output`

This boundary is shared by registry invocation, CLI dispatch, RPC, MCP, and internal callers. `runSafe` only wraps the same boundary in `OpResult`.

## Carrier Rules

- RPC visibility comes from `exposure.rpc`.
- CLI visibility comes from `descriptor.transports.cli`.
- Tool visibility comes from `descriptor.transports.tool`.
- Tool help comes from `doc` and schema descriptions.
- CLI parsing comes from schema-derived params plus `descriptor.transports.cli`.

Carriers may format metadata differently, but they must not invent new semantic sources.

## Runtime State

Runtime-only objects live outside descriptors. ParseBox tails are the main example: the descriptor stores public parsebox metadata, while the live module object is attached as hidden non-enumerable operation metadata.

## Registry And Space

- Registration is atomic.
- Duplicate op ids and tool names are rejected.
- Owner metadata belongs to registry entries, not descriptors.
- Owner and tool-name lookups are indexed.
- Descriptor listing, entry listing, and tool listing scan registry state directly.
- Public tool listing is cached by registry version.
- Owner unload removes all CLI entries in one trie rebuild.

`createSpace()` is the public construction API. The concrete space class is an implementation detail.

## File Boundaries

- `types.ts`: public contracts and errors.
- `compile.ts`: config normalization, validation, descriptor compilation, hidden runtime metadata.
- `define.ts`: validator compilation, execution boundary, error normalization.
- `typebox.ts`: public TypeBox helper entry.
- `schema.ts`: internal TypeBox normalization, JSON Schema projection, param derivation.
- `registry.ts`: operation storage, owner index, tool index, listing, invocation.
- `space.ts`: registry plus CLI facade.
- `adapters/cli/*`: tokenization, trigger trie, candidate parsing, tail helpers.
- `internal/runtime.ts`: hidden operation runtime metadata.

Dependency direction:

`define -> compile -> schema/types`

`space -> registry + cli adapter`

`cli adapter -> descriptor + hidden runtime metadata + cli parser`

## Non-Goals

- Multiple schema systems.
- Carrier-specific help sources.
- A second CLI command DSL.
- Public interceptor trees.
- Per-carrier validation semantics.
- Descriptor fields for live runtime objects.

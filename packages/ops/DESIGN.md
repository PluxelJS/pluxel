# @pluxel/ops Design

`@pluxel/ops` is the control-plane kernel for Pluxel. The package is intentionally small, but its boundaries are strict:

- authoring happens through `defineOp({ ... })`
- runtime state lives in an op registry / space
- every external surface is a projection of the compiled descriptor

The design target is not "generic commands". The design target is one canonical operation model that can be projected into RPC, CLI, MCP, tests, docs, and future carriers without each surface inventing its own metadata.

## 1. The Three Layers

Every op has three layers:

1. Authoring config
   `defineOp({ id, doc, exposure, policy, cli, tool, input, output, execute })`
2. Canonical descriptor
   Compiled once at definition time. This is the stable IR.
3. Carrier projection
   CLI, MCP, RPC, docs, and host tooling only consume the descriptor.

The important rule is that layer 2 is the only semantic source after definition time.

## 2. Canonical Descriptor

`OpDescriptor` is the canonical IR. It is intentionally grouped into five blocks:

- `doc`
  Human / LLM help semantics
- `exposure`
  Cross-carrier visibility that is not itself a carrier projection. Today this is mainly `rpc` and `internal`.
- `policy`
  Runtime execution policy such as `mutating`, `idempotent`, `confirm`, `audit`
- `schemas`
  Canonical JSON Schemas for input / output
- `transports`
  Carrier-specific projections such as compiled CLI metadata and tool metadata

This split is deliberate:

- `doc` answers "what does this mean?"
- `exposure` answers "what non-projection visibility rules apply?"
- `policy` answers "what kind of action is this?"
- `schemas` answer "what can cross the boundary?"
- `transports` answer "how does a specific carrier consume the descriptor?"

If a field does not fit one of those buckets, it probably belongs elsewhere.

## 3. Authoring Rules

Public ops should follow these rules:

- always use `defineOp({ ... })`
- always use TypeBox schemas
- write `doc.title` and `doc.description` for any tool-visible op
- describe every tool-visible object input field with schema `description`
- keep `cli` parse-only: `triggers` and `tail`
- use `tool: true` when the canonical op id is already the public tool name
- only use `tool.name` when a custom external alias is genuinely required
- express action semantics in `policy`, not in carrier glue

Authoring should stay boring. The package does not want a second DSL.

## 4. Help and Tooling Semantics

`doc` is the only help source.

- `doc.title`
  stable display / summary label
- `doc.description`
  one-line summary
- `doc.details`, `doc.usage`, `doc.examples`, `doc.tags`
  additional guidance

Tool metadata is compiled from `doc` and input schema descriptions:

- `tool.description`
  short summary for protocol fields
- `tool.guidance`
  richer compiled help text
- `tool.inputHints`
  lightweight carrier-friendly summary of structured inputs

Carriers must not re-author help text. They may choose which compiled field to expose, but they must not invent a second semantic source.

Carrier visibility follows a single rule:

- RPC visibility comes from `exposure.rpc`
- CLI visibility comes from whether `descriptor.transports.cli` exists
- tool visibility comes from whether `descriptor.transports.tool` exists

There must not be a second boolean mirror for tool / CLI visibility in the descriptor.

## 5. Validation Boundary

The execution boundary is fixed:

`candidate -> validated input -> execute -> validated output`

That boundary is shared by RPC, CLI, MCP, and internal dispatch. If a future fast path is required, it must be explicit in the op model. No carrier is allowed to create a private trusted bypass.

## 6. Registry Rules

The registry is the runtime home of descriptors and operations.

- registration must be atomic
- registration failure must not leave partial CLI / tool state behind
- descriptors and exported metadata are frozen
- caches are versioned from the registry, not from individual carriers

This is why carriers should project from the registry instead of precomputing their own parallel state forever.

## 7. Runtime Namespace Rules

Runtime control-plane ops are special. Their ids and external names are not just strings; they are part of the host contract.

That means runtime integrations are allowed to reserve namespaces such as:

- `plugin.*`
- `plugins.*`
- `runtime.*`

Plugin-authored ops should live in plugin-owned namespaces instead of attempting to reuse host canonical ids.

## 8. Batch Semantics

Batch ops are allowed, but they must say what they are:

- read batch
- sequential mutation batch
- atomic batch

If a batch is sequential best-effort, that fact belongs in the op design and docs. "Batch" must not imply hidden transaction semantics.

## 9. Non-Goals

`@pluxel/ops` intentionally does not provide:

- multiple schema systems
- carrier-specific help backends
- a second CLI authoring DSL
- per-carrier validation semantics
- ad-hoc transport middleware trees detached from ops

The package is intentionally opinionated. The point is to reduce drift, not to be endlessly extensible.

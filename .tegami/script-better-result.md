---
packages:
  '@pluxel/host': major
  '@pluxel/host-vite': major
  '@pluxel/rolldown': major
  '@pluxel/services': major
  '@pluxel/cli': patch
---

# Compose script controls with one shared Better Result

All asynchronous Script SDK controls return `Promise<Result<Value, Error>>`.
Use ordinary `await` and `isErr()` to handle expected failures, and return an
existing control result directly. Import `Result` from
`@pluxel/core/better-result` when constructing a new result or choosing optional
generator composition. Each control operation has one entry; no parallel
throwing, safe, or compatibility methods are retained. Configuration, policy,
and log domain results are projected once, with their redundant `ok` fields
removed while retaining validation details, revisions, persistence uncertainty,
and adoption reports. Lifecycle failures carry the complete report, including
effects that already committed. Expected scope, cancellation, target, and
control-contract failures are typed Err values; unknown implementation defects
continue to reject.

`plugin().instance()` delivers the Plugin directly as its Ok value. The Result
is constructed inside the committed read, protecting Plugins with their own
`then` business member without another instance envelope. Original business
methods retain their signatures, receiver behavior, results, and exceptions.

The script return boundary encodes actual shared Ok/Err instances through the
native Result codec. Plain JSON results remain plain JSON. Domain Err results
remain successfully completed script runs; cancellation and execution defects
retain their original execution state. Payloads retain strict JSON validation
and complete-envelope budgets, with no implicit class or `toJSON` conversion.
Uploaded factories bind that canonical import to the receiver's shared namespace;
direct or indirect copies of the Better Result runtime are rejected.

# Use one Plugin selector in Vite and uploaded scripts

Vite extends `sdk.plugin()` to accept a current Plugin constructor. Each
operation checks that implementation in the same committed read or exclusive
lifecycle session. Cached references fail explicitly after HMR replaces their
implementation. Remove `dev.address`, `dev.instance`, and object-shaped fork
targets; use reference `.fork(id)` and retain `dev.ctx` for Context borrowing.
Constructors preserve instance types; generated descriptors supply accurate
Schema input/output types. Explicit node addresses retain dynamic configuration.

Migrate real project scripts, installed consumers, browser validation callers,
templates, CLI-generated instructions, and public guidance together.

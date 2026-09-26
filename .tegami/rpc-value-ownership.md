---
packages:
  '@pluxel/workbench': major
  '@pluxel/services': major
---

## Consume RPC values at their owning boundary

Workbench replaces `detachWorkbenchPortableValue()` and `WorkbenchDetached<T>` with
`consumeWorkbenchValue()` and `WorkbenchSnapshot<T>`. Queries, mutations and manual value reads
transfer ownership of their entire result tree. The boundary validates, removes transport metadata,
freezes the decoded tree in place and releases its transport result, without a second deep copy.
Local values must be owned or already immutable; callers must not pass borrowed mutable state or
separately dispose a consumed result. Null-prototype objects retain their prototype. Hidden data
properties and non-removable transport metadata are rejected.

Management clients consume transport envelopes before domain parsing. Domain parsers construct the
final immutable snapshot directly, avoiding an intermediate copied tree; opaque config, log and form
values remain independently copied. Portable values reject sparse arrays, extra array properties,
accessors and non-enumerable payload fields. Lifecycle, cache isolation and late-result disposal remain
owned by the existing session and renderer scopes.

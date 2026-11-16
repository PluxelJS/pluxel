---
packages:
  '@pluxel/core': minor
  '@pluxel/host': major
  '@pluxel/host-vite': major
  '@pluxel/rolldown': major
  '@pluxel/cli': major
  '@pluxel/services': major
  '@pluxel/create': patch
  '@pluxel/workbench': patch
  '@pluxel/plugin-auth': major
  '@pluxel/plugin-wretch': major
  '@pluxel/plugin-playwright': major
  '@pluxel/plugin-invoice': major
  '@pluxel/plugin-canvas': major
  '@pluxel/plugin-echarts': major
  '@pluxel/plugin-fonts': major
  '@pluxel/plugin-takumi': major
  '@pluxel/plugin-takumi-markdown': major
---

# Unify Plugin addresses, execution results and maintenance paths

Select a Plugin only with `sdk.plugin(Provider.nodeAddress())`, or pass a fork ID
to `nodeAddress(id)`. Source classes and generated control providers share these
identity methods. References no longer have `fork()`. Host configuration owners,
auto-start policy, provider selection and deployment bindings also require full
node addresses; implementation assembly and constructor dependencies keep their
code-loading roles.

Addresses retain exact constructor or generated contract evidence through type
erasure. Copies with detached evidence fail; JSON and explicit parsing produce
plain dynamic addresses without instance capability. Configuration and instance
guards run inside the committed lookup or mutation transaction. Preserve native
instance types, generated configuration input/output types, Schema expressions
and JSDoc, including union restrictions and HMR invalidation.
Script JSON encoding projects original registered addresses to identity, including
nested values and Result payloads, without exporting their execution evidence.

Upgrade control materials to format 2 and uploaded factories to
`pluxel-js-factory/4`; rebuild materials and recompile uploads. Generated modules
use the verified standard Host address factory without loading Plugin code.
Control publishers declare a compatible Host peer, optional when only their
control entry requires it. Builds reject missing or nested runtime Host
dependencies instead of changing authored dependency contracts.

Sync controls into canonical-entry modules with ordinary named exports and
return exact `module`/`exportName` import information. Discovery now returns
`{ nodes, catalogRevision, runtimeStateRevision }`. CLI operations share
`{ ok, value/error }` output, progress `stage`, terminal exit handling and v3
receipts. Query or cancel either local or remote executions with `script
result/cancel`; remove the old `dev result/cancel` commands and receipt readers.
Receipts remain bound to the original instance and request hash.

Host owns apply-report parsing and outcome classification. Management and Script
consumers retain lifecycle failures, persistence uncertainty and complete reports.
Management wire major 11 rejects incompatible owners before issuing mutations.
Workbench refreshes committed changes even when lifecycle work fails. Read one
node through the same status projector without projecting and sorting the whole
list. Script scopes support `await using` through their existing idempotent
disposal promise and drain accepted work without closing the borrowed Host.
Service test drivers use capability tokens without eagerly loading optional
Commands runtime dependencies when no command service was selected.

Keep script author types at `@pluxel/agent-sdk/host`, execution APIs at
`@pluxel/host/internal/agent/runtime`, and control-format tools solely at Host's internal
entry. Rolldown's control entry exports generation APIs. Update known consumers,
templates, offline guides and skill routing together, removing duplicate API
tutorials and obsolete forwarding exports.

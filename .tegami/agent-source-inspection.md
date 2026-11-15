---
packages:
  '@pluxel/host': major
  '@pluxel/host-vite': minor
  '@pluxel/rolldown': minor
  '@pluxel/create': minor
  '@pluxel/cli': patch
---

# Locate author source from the Plugin definition address

Use ordinary functions from `@pluxel/agent-sdk/source` for declarations, Parts, Schema, dependencies, application inputs and package checks. Calls receive an explicit root/application and settle their own file IO. The shared compiler semantics remain read-only and never execute project code. Source results identify current disk content with runtime matching explicitly unverified.

`@pluxel/agent-sdk/host` publishes Host SDK types and `createScriptScope` for runtime operations. Discovered nodes provide `address.definition` for source queries; concrete and abstract dependencies use the same definition identity. Source querying does not require a Host, Vite console, script executor or lifecycle wrapper.

`plugins.list({ packageName, definition, limit, cursor })` now returns bounded pages (default 50, maximum 200) with `nextCursor`. Filters apply before status projection. Cursors continue across runs on the same unchanged Host and return `cursor_stale` after query, owner or revision changes. Callers that need every node must consume all pages.

The starter includes a real source inspection script verified by its installed-consumer smoke. Workspace routing, generated AGENTS, the development skill, CLI resources and business scripts use the same default address selection.

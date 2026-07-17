---
'@pluxel/runtime': major
'@pluxel/runtime-static': major
'@pluxel/runtime-dynamic': major
'@pluxel/rolldown': major
'@pluxel/cli': major
---

Replace the document collection and plugin-data stack with one PostgreSQL/Drizzle database capability.
Add owner-bound `ctx.database.use()` handles, lazy PGlite and explicit pooled PostgreSQL backends,
isolated schemas and roles, checked migrations, transactional invalidation outbox, and runtime-validated
Workbench `liveQuery` snapshot/ordered-patch resources.

Add `pluxel database generate/check/rebase`, immutable database lineages, atomic candidate-instance
promotion with archived old data, artifact-fingerprint startup fast paths, and compiler materialization
of checked-in `drizzle/` artifacts.
Database definitions may instead opt into `reset-on-schema-change` for disposable or rebuildable data;
the compiler generates a stable schema-derived baseline and lineage without checked-in migration history.
Remove the previous browser-write, managed collection, builtin form/action/resource-select, SQLite,
SignalDB, and host `pluginData` surfaces without compatibility aliases. Hosts now configure database
startup policy through the top-level `database` option; browser mutation goes through typed RPC.

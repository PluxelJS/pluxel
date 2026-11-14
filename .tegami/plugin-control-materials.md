---
packages:
  '@pluxel/host': minor
  '@pluxel/services': major
  '@pluxel/cli': major
---

## Use generated Plugin contracts in ordinary scripts

Export `PluginDescriptor<Input, Output, Instance>` and extend the existing Script
SDK with typed descriptor and fork targets. Configuration writes infer schema
input, successful reads infer readonly validated output, and raw observations
retain their unknown values. Select a target with `sdk.plugin(descriptor)`;
its `instance()` returns an envelope containing a generation-bound instance
view with the canonical Plugin class type.

Provide one portable control-manifest parser, deterministic descriptor renderer
and integrity verifier for generators, script compilation and material readers.
Read material only from the committed implementation candidate and transfer it
through a bounded, expiring session cache with snapshot-bound file chunks.

## Synchronize contracts without enabling script execution

Management protocol major 10 adds authenticated, read-only Plugin control
material methods and the `plugins.control-materials` capability. Material reads
remain available when `managementHttp({ scripts: false })` disables execution.

Add `pluxel script sync --endpoint ... --credentials-file ... --out ...` and
`pluxel dev sync --out ...`. Both commands use the existing authenticated
connection and the same integrity checks. A complete immutable snapshot is
published before atomically switching the tool-owned `current/index.mjs`
entry. The JSON result reports each definition's stable import and export name;
conflicting author files and edited immutable snapshots are preserved.

Script execution and read-only synchronization share one credential/session
implementation. Execution still requires its separate `bootstrap.execution`
grant; synchronization neither enables it nor creates an execution owner.

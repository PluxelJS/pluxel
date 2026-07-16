---
'@pluxel/runtime': minor
'@pluxel/runtime-static': minor
'@pluxel/runtime-dynamic': minor
---

Reduce inactive runtime control-plane surfaces while retaining the existing SignalDB-backed Workbench collection model. Remove the unused runtimeDev batch mirror and permanently failing snapshot RPC, replace the generic package-manager feature registry with one exact nullable RPC capability, consolidate workspace-only route/state/protocol helpers under the internal runtime entry, and remove the legacy builtin document extension adapter without changing managed collection behavior.
